# AgentCall CLI Branch — Network Mode Design

## Goal

Add a **network mode** to AgentCall so the PC gateway and Android phone communicate over TCP (Tailscale / LAN / internet) instead of USB/ADB, with a CLI-based installation and native MCP support for cloud Hermes. The existing USB code path is untouched.

## Architecture

### Existing (USB mode — unchanged)

```
PC: gatewayd → DeviceClient(127.0.0.1) → ADB forward → phone:27183
PC: gatewayd → BootstrapTransport(127.0.0.1) → ADB forward → phone:27183
Phone: UsbGatewayServer binds 127.0.0.1:27183
```

### New (network mode)

```
PC: gatewayd → NetworkDeviceClient(phone-host:phone-port) → TCP → phone:phone-port
PC: gatewayd → NetworkBootstrapTransport(phone-host:phone-port) → TCP → phone:phone-port
Phone: NetworkGatewayServer binds 0.0.0.0:phone-port (configurable)
```

The G2 framing protocol, auth protocol, command protocol, and PCM contract are **identical** — only the transport layer changes.

## Components to add/modify

### PC side (JavaScript/Node.js) — `pc/pc-gateway/src/`

| File | Action | Purpose |
|------|--------|---------|
| `network-device-client.js` | **NEW** | TCP device client connecting to `host:port` instead of loopback. Reuses framing.js, same interface as DeviceClient. |
| `network-bootstrap-transport.js` | **NEW** | TCP bootstrap transport connecting to `host:port` instead of loopback. Reuses bootstrap-protocol.js. |
| `network-adb-manager.js` | **NEW** | No-op manager for network mode (no ADB). Validates phone host/port config. |
| `runtime-config.js` | **MODIFY** | Add `AGENTCALL_MODE=network`, `AGENTCALL_PHONE_HOST`, `AGENTCALL_PHONE_PORT`, `AGENTCALL_NETWORK_TLS` env vars. |
| `gateway.js` | **MODIFY** | Accept network or USB device/client based on mode. |
| `gatewayd.js` | **MODIFY** | Initialize network mode when `AGENTCALL_MODE=network`. |
| `mcp-server.js` | **NO CHANGE** | Talks to gatewayd via Unix socket — unaffected. |

### Phone side (Kotlin) — `app/src/main/java/com/callagent/gateway/`

| File | Action | Purpose |
|------|--------|---------|
| `network/NetworkGatewayServer.kt` | **NEW** | TCP server binding to configurable address:port. Same protocol engine as UsbGatewayServer. |
| `network/NetworkGatewayService.kt` | **NEW** | Service that starts/stops the network listener. |
| `usb/UsbGatewayServer.kt` | **NO CHANGE** | Existing USB server untouched. |
| `usb/UsbGatewayService.kt` | **MODIFY** | Add mode selection; start network service when in network mode. |

### CLI entry point

| File | Action | Purpose |
|------|--------|---------|
| `pc/cli/agentcall-cli.js` | **NEW** | CLI tool for: status, pair, dial, answer, hangup, configure — usable without the desktop app. |
| `pc/package.json` | **MODIFY** | Add `agentcall-cli` bin entry. |

### Desktop app

| File | Action | Purpose |
|------|--------|---------|
| Desktop UI | **MODIFY** | Add mode selector (USB / Network) and network config fields. |

## EqualAI analysis

**What EqualAI does:**
- Cloud-based AI call assistant for India
- Phone app acts as default dialer (similar to AgentCall)
- Incoming calls: user declines → EqualAI app answers → AI converses → summary sent to user
- Outgoing: user requests call via app → EqualAI places it → AI converses
- Audio: captured from phone's telephony stack, sent to cloud for STT → AI → TTS → back to phone for playback
- Languages: Hindi, Tamil, Telugu, Kannada, Marathi, Gujarati, English
- Raised $30M Series B (June 2026), founded by Keshav Reddy (GVK family)

**Duplex communication — how EqualAI likely solves it:**
- Phone app captures telephony audio (protected audio API / app-specific audio focus)
- Captured PCM streamed to cloud over HTTPS/WebSocket
- Cloud: STT → LLM → TTS → audio stream back
- Playback: phone injects audio into call via telephony audio API
- Latency budget: ~200-500ms round-trip (acceptable for voice, not for real-time interruption)

**AgentCall's advantage over EqualAI's approach:**
- AgentCall does **local** processing — no audio leaves the machine until recording
- Lower latency: PCM stays on local network, STT/TTS via local API calls
- Privacy: audio doesn't stream to a cloud server for processing
- The G2 protocol already handles duplex PCM frames; network mode just changes the transport

**Magisk module relevance for network mode:**
- The Magisk module grants protected audio permissions to the APK — these are **independent** of USB vs network
- Same module works for both modes
- Network mode doesn't need any new permissions beyond what the USB mode already uses

## Network protocol details

### Transport
- Plain TCP for LAN/Tailscale (low latency, trusted network)
- Optional TLS for internet deployment (`AGENTCALL_NETWORK_TLS=true`)
- Phone binds to `0.0.0.0` or specific interface; PC connects to phone's Tailscale IP

### Port
- Default: `27183` (same as USB mode, but now a real bind, not ADB-forwarded)
- Configurable via `AGENTCALL_PHONE_PORT`

### Authentication
- Same HMAC-SHA256 challenge-response as USB mode
- `enrollmentSecret` (32-byte controller key) stored on phone, same as USB
- Bootstrap protocol (X25519 + AES-256-GCM) identical — just over TCP instead of ADB-forwarded loopback

### PCM streaming
- 16kHz mono PCM16, 20ms frames (640 bytes) — identical to USB mode
- Network latency adds 10-50ms on Tailscale, acceptable for voice
- Jitter buffer: phone side already has `BoundedFrameBuffer`; PC side downlink queue handles ordering

## Security considerations

1. **Network exposure**: Phone listens on a port accessible from the network. Mitigate:
   - Tailscale-only: phone binds to Tailscale interface IP, not public IP
   - Firewall: restrict port to Tailscale subnet
   - Optional TLS for internet deployment
2. **Authentication**: Same strong auth as USB mode — HMAC challenge-response + X25519 bootstrap
3. **Pairing**: First-time pairing over network requires the enrollment secret to be transferred securely (QR code, manual entry, or pre-provisioned)
4. **Rate limiting**: Already present in `UsbGatewayServer` via idempotency cache; applies to network mode too

## CLI tool design

```
agentcall-cli status          # Gateway status, phone connection, call state
agentcall-cli pair <host>     # Initiate network pairing with phone
agentcall-cli dial <number>   # Place outgoing call
agentcall-cli answer          # Answer incoming call
agentcall-cli hangup          # Hang up current call
agentcall-cli reject          # Reject incoming call
agentcall-cli speak <text>    # Speak text during active call
agentcall-cli send-dtmf <digits>  # Send DTMF
agentcall-cli configure       # Interactive configuration wizard
agentcall-cli setup-network   # Step-by-step network mode setup
```

## Files unchanged (existing USB mode preserved)

- `pc/pc-gateway/src/device-client.js` — USB mode device client
- `pc/pc-gateway/src/bootstrap-transport.js` — USB mode bootstrap
- `pc/pc-gateway/src/adb-manager.js` — USB mode ADB manager
- `app/src/main/java/com/callagent/gateway/usb/UsbGatewayServer.kt` — USB phone server
- `app/src/main/java/com/callagent/gateway/usb/UsbGatewayService.kt` — USB service
- All framing, protocol, command, recording, realtime, provider files

## Implementation order

1. PC: `network-device-client.js` + `network-bootstrap-transport.js`
2. PC: `runtime-config.js` — network mode env vars
3. PC: `gateway.js` — accept network device client
4. PC: `gatewayd.js` — initialize network mode
5. Phone: `NetworkGatewayServer.kt` + `NetworkGatewayService.kt`
6. Phone: Update service to support both modes
7. PC: CLI tool `agentcall-cli.js`
8. Desktop: Mode selector UI
9. Tests for network mode
