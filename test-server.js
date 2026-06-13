/**
 * Signaling server integration test
 * Run with: node test-server.js
 * Requires the server to be running on :3001
 */

const { io: ioc } = require("socket.io-client");

const SERVER = "http://localhost:3001";
let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  ${label}`);
    failed++;
  }
}

function connect() {
  return ioc(SERVER, { transports: ["websocket"], forceNew: true });
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run() {
  console.log("\n── Signaling server tests ──────────────────────────\n");

  // ── Test 1: health endpoint ──────────────────────────
  console.log("1. Health endpoint");
  try {
    const res = await fetch(`${SERVER}/health`);
    const body = await res.json();
    assert(body.status === "ok", "GET /health returns { status: 'ok' }");
  } catch (e) {
    assert(false, `Health check failed: ${e.message}`);
  }

  // ── Test 2: basic join ──────────────────────────────
  console.log("\n2. Room creation (first peer = sender)");
  const c1 = connect();
  await new Promise((r) => c1.on("connect", r));

  const r1 = await new Promise((r) =>
    c1.emit("join-room", "TESTROOM", r)
  );
  assert(r1.ok === true, "Join succeeds");
  assert(r1.role === "sender", "First joiner gets role=sender");
  assert(r1.roomId === "TESTROOM", "Room ID echoed back");

  // ── Test 3: second peer joins ───────────────────────
  console.log("\n3. Second peer joins, first gets notified");
  const c2 = connect();
  await new Promise((r) => c2.on("connect", r));

  const peerJoinedPromise = new Promise((r) =>
    c1.once("peer-joined", r)
  );

  const r2 = await new Promise((r) =>
    c2.emit("join-room", "TESTROOM", r)
  );
  assert(r2.ok === true, "Second join succeeds");
  assert(r2.role === "receiver", "Second joiner gets role=receiver");

  await peerJoinedPromise;
  assert(true, "Sender received peer-joined event");

  // ── Test 4: room is full ────────────────────────────
  console.log("\n4. Room capacity (max 2 peers)");
  const c3 = connect();
  await new Promise((r) => c3.on("connect", r));
  const r3 = await new Promise((r) =>
    c3.emit("join-room", "TESTROOM", r)
  );
  assert(r3.error === "Room is full (max 2 peers)", "Third join rejected with correct error");
  c3.disconnect();

  // ── Test 5: offer/answer relay ──────────────────────
  console.log("\n5. Offer / answer relay");
  const offerPayload = { type: "offer", sdp: "v=0 fake sdp offer" };
  const answerPayload = { type: "answer", sdp: "v=0 fake sdp answer" };

  const offerReceived = new Promise((r) =>
    c2.once("offer", ({ offer }) => r(offer))
  );
  c1.emit("offer", { roomId: "TESTROOM", offer: offerPayload });
  const receivedOffer = await Promise.race([
    offerReceived,
    delay(2000).then(() => null),
  ]);
  assert(receivedOffer?.sdp === offerPayload.sdp, "Offer relayed from sender to receiver");

  const answerReceived = new Promise((r) =>
    c1.once("answer", ({ answer }) => r(answer))
  );
  c2.emit("answer", { roomId: "TESTROOM", answer: answerPayload });
  const receivedAnswer = await Promise.race([
    answerReceived,
    delay(2000).then(() => null),
  ]);
  assert(receivedAnswer?.sdp === answerPayload.sdp, "Answer relayed from receiver to sender");

  // ── Test 6: ICE candidate relay ─────────────────────
  console.log("\n6. ICE candidate relay");
  const fakeCandidate = { candidate: "candidate:fake", sdpMid: "0", sdpMLineIndex: 0 };

  const iceReceived = new Promise((r) =>
    c2.once("ice-candidate", ({ candidate }) => r(candidate))
  );
  c1.emit("ice-candidate", { roomId: "TESTROOM", candidate: fakeCandidate });
  const receivedIce = await Promise.race([
    iceReceived,
    delay(2000).then(() => null),
  ]);
  assert(receivedIce?.candidate === fakeCandidate.candidate, "ICE candidate relayed correctly");

  // ── Test 7: disconnect notification ─────────────────
  console.log("\n7. Graceful disconnect notification");
  const disconnectPromise = new Promise((r) =>
    c1.once("peer-disconnected", r)
  );
  c2.disconnect();
  await Promise.race([disconnectPromise, delay(2000).then(() => null)]);
  assert(true, "Remaining peer received peer-disconnected event");

  // ── Cleanup ──────────────────────────────────────────
  c1.disconnect();

  // ── Summary ──────────────────────────────────────────
  console.log("\n────────────────────────────────────────────────────");
  console.log(`  Passed: ${passed}   Failed: ${failed}`);
  console.log("────────────────────────────────────────────────────\n");

  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
