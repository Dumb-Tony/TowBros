/* Two ways to reach another player without asking anybody's server for permission.
 *
 * ── THE CONSTRAINT, AND WHY IT DECIDED THE DESIGN ────────────────────────────────────
 * This project's standing rule is zero external requests: no CDN, no analytics, nothing fetched
 * from any host. That rules out the usual answer to browser multiplayer, which is a signalling
 * server — PeerJS, a socket relay, or a lobby service — because introducing two browsers is
 * normally somebody else's computer's job.
 *
 * It does not rule out multiplayer. It rules out *matchmaking*. Two transports here, both with no
 * server of any kind:
 *
 *   BroadcastChannelPeer   two tabs of the same browser. Zero network. This is the one that makes
 *                          co-op testable by one person, and it is a genuine transport rather than
 *                          a mock — the session cannot tell it from a wire.
 *
 *   ManualWebRtcPeer       two machines, real WebRTC data channel, and the signalling done BY THE
 *                          PLAYERS: one copies a blob of text and sends it to the other however
 *                          they already talk. No ICE servers by default, so only host candidates
 *                          are gathered and the pair must be on the same network — which is what
 *                          "no external requests" honestly buys you. Pass a STUN server explicitly
 *                          if you want to cross NATs and are willing to spend the request.
 *
 * Both expose the same three things the session needs: `send(obj)`, an `onMessage(obj)` hook, and
 * `close()`. Nothing above this file knows which one it has.
 */

/* ── same browser, different tabs ──────────────────────────────────────────── */

/**
 * BroadcastChannel between tabs of one browser on one origin.
 *
 * Reliable, ordered, in-process, and sub-millisecond, so it is the best possible case for a
 * lockstep session and therefore the honest place to test that lockstep works at all. It is also
 * how you playtest two-player co-op alone: open the page twice.
 *
 * Note that a BroadcastChannel never receives its own posts, but two channel objects in the SAME
 * document do hear each other — which is what the test suite uses to run two whole simulations
 * against each other inside one headless page.
 */
export class BroadcastChannelPeer {
  constructor(room = 'towbros') {
    this.room = room;
    this.onMessage = null;
    this.closed = false;
    this.sent = 0;
    this.received = 0;
    this.ch = new BroadcastChannel(`towbros:${room}`);
    this.ch.onmessage = (ev) => {
      this.received++;
      if (this.onMessage) this.onMessage(ev.data);
    };
  }

  get label() { return `local tabs · room "${this.room}"`; }
  get connected() { return !this.closed; }

  send(obj) {
    if (this.closed) return false;
    this.ch.postMessage(obj);
    this.sent++;
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.ch.close(); } catch { /* already gone */ }
  }
}

/* ── two machines, no server ───────────────────────────────────────────────── */

/**
 * WebRTC with the signalling done by hand.
 *
 * The handshake WebRTC needs is two blobs of text. Normally a server passes them; here the players
 * do, through whatever chat window they already have open. It is clunky exactly once per session
 * and it costs nothing and asks nobody's permission.
 *
 *   host:  const p = new ManualWebRtcPeer({ host: true });
 *          const offer = await p.createOffer();     // send this text to your friend
 *          await p.acceptRemote(theirAnswer);       // paste what comes back
 *
 *   guest: const p = new ManualWebRtcPeer({ host: false });
 *          const answer = await p.acceptOffer(theirOffer);   // send this text back
 *
 * `iceServers` is empty by default. That gathers host candidates only — real IP addresses on the
 * local network — so two machines on the same LAN or VPN connect and two behind different NATs do
 * not. Crossing a NAT needs a STUN server to discover the public address, which is an external
 * request; it is available as an explicit argument rather than as a silent default, because
 * spending the project's one hard rule should be a decision somebody makes on purpose.
 *
 * The channel is ordered and reliable. It does not have to be — the frame protocol repeats the
 * last eight frames in every message specifically so it tolerates loss — but ordered-and-reliable
 * is the right default and unordered is a tuning exercise for a real latency problem.
 */
export class ManualWebRtcPeer {
  constructor({ host = false, iceServers = [] } = {}) {
    this.isHost = !!host;
    this.onMessage = null;
    this.onOpen = null;
    this.onClose = null;
    this.closed = false;
    this.sent = 0;
    this.received = 0;
    this.state = 'new';

    this.pc = new RTCPeerConnection({ iceServers });
    this.pc.oniceconnectionstatechange = () => {
      this.state = this.pc.iceConnectionState;
      if (this.state === 'failed' || this.state === 'closed') this.close();
    };

    if (host) {
      this._bindChannel(this.pc.createDataChannel('tb', { ordered: true }));
    } else {
      this.pc.ondatachannel = (ev) => this._bindChannel(ev.channel);
    }
  }

  get label() { return `webrtc · ${this.state}`; }
  get connected() { return !!this.ch && this.ch.readyState === 'open'; }

  _bindChannel(ch) {
    this.ch = ch;
    ch.onopen = () => { this.state = 'open'; if (this.onOpen) this.onOpen(); };
    ch.onclose = () => this.close();
    ch.onmessage = (ev) => {
      this.received++;
      // JSON, not a binary format. A frame is 32 bits of payload in a message that is mostly
      // punctuation, and a 60 Hz stream of those is a few kB/s — small enough that inventing a
      // binary encoding would be optimising the wrong thing while making it undebuggable.
      let m = null;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (this.onMessage) this.onMessage(m);
    };
  }

  /**
   * Gather candidates and produce the blob the other side pastes.
   *
   * It waits for ICE gathering to FINISH rather than trickling candidates, because trickle needs a
   * live channel between the peers to trickle down — which is the thing that does not exist yet.
   * One complete blob is the only shape that works over copy-and-paste.
   */
  async _describe() {
    if (this.pc.iceGatheringState !== 'complete') {
      await new Promise((resolve) => {
        const done = () => {
          if (this.pc.iceGatheringState === 'complete') {
            this.pc.removeEventListener('icegatheringstatechange', done);
            resolve();
          }
        };
        this.pc.addEventListener('icegatheringstatechange', done);
        // A peer with no reachable candidates would otherwise hang here forever.
        setTimeout(() => { this.pc.removeEventListener('icegatheringstatechange', done); resolve(); }, 3000);
      });
    }
    return encodeBlob(this.pc.localDescription);
  }

  /** Host, step 1. Returns the text to send to the other player. */
  async createOffer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return this._describe();
  }

  /** Guest, step 1. Takes the host's text, returns the text to send back. */
  async acceptOffer(blob) {
    await this.pc.setRemoteDescription(decodeBlob(blob));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return this._describe();
  }

  /** Host, step 2. Takes the guest's text. The channel opens shortly after. */
  async acceptRemote(blob) {
    await this.pc.setRemoteDescription(decodeBlob(blob));
  }

  send(obj) {
    if (!this.connected) return false;
    this.ch.send(JSON.stringify(obj));
    this.sent++;
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { if (this.ch) this.ch.close(); } catch { /* already gone */ }
    try { this.pc.close(); } catch { /* already gone */ }
    if (this.onClose) this.onClose();
  }
}

/* ── the blob ──────────────────────────────────────────────────────────────── */

/*
 * A session description is a few kB of newline-separated SDP, and it has to survive being pasted
 * through a chat window that may wrap lines, eat leading whitespace or "helpfully" autocorrect.
 * Base64 of the JSON survives all of that, and it also stops it looking like something a player
 * should edit — because it is not.
 */
export function encodeBlob(desc) {
  const json = JSON.stringify({ type: desc.type, sdp: desc.sdp });
  return btoa(unescape(encodeURIComponent(json)));
}

export function decodeBlob(text) {
  const json = decodeURIComponent(escape(atob(String(text).trim())));
  return JSON.parse(json);
}

/** Is a real WebRTC connection even possible here? file:// and old browsers say no. */
export const webRtcAvailable = () => typeof RTCPeerConnection === 'function';
export const broadcastAvailable = () => typeof BroadcastChannel === 'function';
