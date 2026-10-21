/*
 * Copyright (C) 2026  Encelade SRL
 * Copyright (C) 2026  elephantchess.io
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Voice call states.
 */
const VoiceCallState = Object.freeze({
    IDLE: 'IDLE',
    CALLING: 'CALLING',
    RINGING: 'RINGING',
    IN_CALL: 'IN_CALL',
});

/**
 * Wraps RTCPeerConnection for 1v1 voice calls between the two players of a game.
 *
 * Signaling (offer/answer/ICE) is relayed by the game server over the existing
 * PvP websocket; audio itself flows peer-to-peer (WebRTC) and never touches the server.
 *
 * Usage: construct with callbacks, then call startCall() / acceptCall() / rejectCall()
 * / hangUp(). Incoming signals from the websocket must be fed via handleSignal().
 */
class VoiceCallManager {

    /**
     * @type {RTCPeerConnection|null}
     */
    #peerConnection = null;

    /**
     * @type {MediaStream|null}
     */
    #localStream = null;

    /**
     * @type {string}
     */
    #state = VoiceCallState.IDLE;

    /**
     * @type {function(string): void} sends a signaling message to the opponent
     *   (type, payload) => void, payload is a JSON string or null
     */
    #sendSignal;

    #onStateChange = (state) => console.log('voice call state: ' + state);
    #onIncomingCall = () => console.log('incoming voice call');
    #onCallEnded = () => console.log('voice call ended');
    #onError = (msg) => console.log('voice call error: ' + msg);
    #onRemoteMicChange = (muted) => console.log('remote mic muted: ' + muted);

    /**
     * @param sendSignal {function(string, string|null): void}
     */
    constructor(sendSignal) {
        this.#sendSignal = sendSignal;
    }

    get state() {
        return this.#state;
    }

    get isMuted() {
        if (this.#localStream == null) {
            return false;
        }
        const tracks = this.#localStream.getAudioTracks();
        return tracks.length > 0 && !tracks[0].enabled;
    }

    onStateChange(cb) {
        this.#onStateChange = cb;
    }

    onIncomingCall(cb) {
        this.#onIncomingCall = cb;
    }

    onCallEnded(cb) {
        this.#onCallEnded = cb;
    }

    onError(cb) {
        this.#onError = cb;
    }

    onRemoteMicChange(cb) {
        this.#onRemoteMicChange = cb;
    }

    /**
     * Outgoing call: acquire microphone, create offer, send to opponent.
     */
    async startCall() {
        if (this.#state !== VoiceCallState.IDLE) {
            console.warn('startCall ignored, current state: ' + this.#state);
            return;
        }
        try {
            await this.#setupPeerConnection();
            this.#setState(VoiceCallState.CALLING);
            const offer = await this.#peerConnection.createOffer();
            await this.#peerConnection.setLocalDescription(offer);
            this.#sendSignal('CALL_OFFER', JSON.stringify(offer));
        } catch (e) {
            console.error(e);
            this.#cleanup();
            this.#onError('Không thể bắt đầu cuộc gọi. Hãy kiểm tra quyền micro của trình duyệt.');
        }
    }

    /**
     * Accept an incoming call: acquire microphone, create answer, send to opponent.
     * @param offerJson {string} remote SDP offer received via signaling
     */
    async acceptCall(offerJson) {
        if (this.#state !== VoiceCallState.RINGING) {
            console.warn('acceptCall ignored, current state: ' + this.#state);
            return;
        }
        try {
            await this.#setupPeerConnection();
            await this.#peerConnection.setRemoteDescription(JSON.parse(offerJson));
            this.#setState(VoiceCallState.IN_CALL);
            const answer = await this.#peerConnection.createAnswer();
            await this.#peerConnection.setLocalDescription(answer);
            this.#sendSignal('CALL_ANSWER', JSON.stringify(answer));
        } catch (e) {
            console.error(e);
            this.#cleanup();
            this.#onError('Không thể nghe máy. Hãy kiểm tra quyền micro của trình duyệt.');
        }
    }

    /**
     * Decline an incoming call (back to IDLE, notify opponent).
     */
    rejectCall() {
        if (this.#state !== VoiceCallState.RINGING) {
            return;
        }
        this.#sendSignal('CALL_REJECT', null);
        this.#cleanup();
    }

    /**
     * End the call (from any state), notify opponent.
     */
    hangUp() {
        if (this.#state === VoiceCallState.IDLE) {
            return;
        }
        this.#sendSignal('CALL_END', null);
        this.#cleanup();
        this.#onCallEnded();
    }

    /**
     * @param type {string} CALL_OFFER | CALL_ANSWER | ICE_CANDIDATE | CALL_REJECT | CALL_END | MIC_MUTED | MIC_UNMUTED
     * @param payload {string|null} JSON string or null
     */
    async handleSignal(type, payload) {
        switch (type) {
            case 'CALL_OFFER':
                if (this.#state !== VoiceCallState.IDLE) {
                    // busy: auto-decline so the caller is not left hanging
                    this.#sendSignal('CALL_REJECT', null);
                    return;
                }
                this.#pendingOffer = payload;
                this.#setState(VoiceCallState.RINGING);
                this.#onIncomingCall();
                break;
            case 'CALL_ANSWER':
                if (this.#state === VoiceCallState.CALLING && payload != null) {
                    try {
                        await this.#peerConnection.setRemoteDescription(JSON.parse(payload));
                        this.#setState(VoiceCallState.IN_CALL);
                    } catch (e) {
                        console.error(e);
                        this.#cleanup();
                        this.#onError('Kết nối thoại thất bại.');
                    }
                }
                break;
            case 'ICE_CANDIDATE':
                if (this.#peerConnection != null && payload != null) {
                    try {
                        await this.#peerConnection.addIceCandidate(JSON.parse(payload));
                    } catch (e) {
                        console.error(e);
                    }
                }
                break;
            case 'CALL_REJECT':
                if (this.#state === VoiceCallState.CALLING) {
                    this.#cleanup();
                    this.#onError('Đối thủ đã từ chối cuộc gọi.');
                }
                break;
            case 'CALL_END':
                if (this.#state !== VoiceCallState.IDLE) {
                    this.#cleanup();
                    this.#onCallEnded();
                }
                break;
            case 'MIC_MUTED':
                this.#onRemoteMicChange(true);
                break;
            case 'MIC_UNMUTED':
                this.#onRemoteMicChange(false);
                break;
            default:
                console.warn('unknown voice call signal type: ' + type);
        }
    }

    /**
     * Returns the stored incoming offer (for acceptCall after user presses answer).
     * @return {string|null}
     */
    takePendingOffer() {
        const offer = this.#pendingOffer ?? null;
        this.#pendingOffer = null;
        return offer;
    }

    /**
     * Toggles the local microphone and notifies the opponent.
     * @return {boolean} true if microphone is now muted
     */
    toggleMute() {
        if (this.#localStream == null) {
            return false;
        }
        let muted = false;
        this.#localStream.getAudioTracks().forEach((track) => {
            track.enabled = !track.enabled;
            muted = !track.enabled;
        });
        this.#sendSignal(muted ? 'MIC_MUTED' : 'MIC_UNMUTED', null);
        return muted;
    }

    /**
     * Force cleanup (e.g. game finished). Does not notify the opponent.
     */
    dispose() {
        this.#cleanup();
    }

    async #setupPeerConnection() {
        const stream = await navigator.mediaDevices.getUserMedia({audio: true});
        this.#localStream = stream;
        this.#peerConnection = new RTCPeerConnection({
            iceServers: [{urls: 'stun:stun.l.google.com:19302'}]
        });
        stream.getTracks().forEach((track) => this.#peerConnection.addTrack(track, stream));
        this.#peerConnection.onicecandidate = (e) => {
            if (e.candidate != null) {
                this.#sendSignal('ICE_CANDIDATE', JSON.stringify(e.candidate));
            }
        };
        this.#peerConnection.ontrack = (e) => {
            let audio = document.getElementById('voice-call-remote-audio');
            if (audio == null) {
                audio = document.createElement('audio');
                audio.id = 'voice-call-remote-audio';
                audio.autoplay = true;
                document.body.appendChild(audio);
            }
            audio.srcObject = e.streams[0];
        };
        this.#peerConnection.onconnectionstatechange = () => {
            const s = this.#peerConnection?.connectionState;
            if (s === 'failed' || s === 'disconnected') {
                console.warn('voice peer connection state: ' + s);
            }
        };
    }

    #setState(state) {
        this.#state = state;
        this.#onStateChange(state);
    }

    #cleanup() {
        if (this.#peerConnection != null) {
            try {
                this.#peerConnection.close();
            } catch (e) {
                console.error(e);
            }
            this.#peerConnection = null;
        }
        if (this.#localStream != null) {
            this.#localStream.getTracks().forEach((track) => track.stop());
            this.#localStream = null;
        }
        const audio = document.getElementById('voice-call-remote-audio');
        if (audio != null) {
            audio.srcObject = null;
            audio.remove();
        }
        this.#pendingOffer = null;
        this.#onRemoteMicChange(false);
        this.#setState(VoiceCallState.IDLE);
    }

    /**
     * @type {string|null}
     */
    #pendingOffer = null;

}
