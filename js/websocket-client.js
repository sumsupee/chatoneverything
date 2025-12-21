/**
 * Shared WebSocket Client for handling connections, heartbeats, and reconnection.
 */
export class LiveChatClient {
    constructor(callbacks = {}, config = {}) {
        this.callbacks = {
            onOpen: () => { },
            onMessage: () => { },
            onClose: () => { },
            onError: () => { },
            onStatusChange: () => { }, // (connected, text) => {}
            ...callbacks
        };

        this.config = {
            reconnectDelayBase: 1000,
            maxReconnectAttempts: 50,
            heartbeatInterval: 25000,
            ...config
        };

        this.ws = null;
        this.reconnectTimer = null;
        this.heartbeatTimer = null;
        this.reconnectAttempts = 0;
        this.isExplicitlyDisconnected = true;
        this.currentUrl = '';
    }

    /**
     * Connects to the specified WebSocket URL.
     * @param {string} url - The WebSocket URL (ws:// or wss://)
     */
    connect(url) {
        this.currentUrl = url;
        this.isExplicitlyDisconnected = false;
        this.attemptReconnect();
    }

    /**
     * Internal method to attempt connection.
     */
    attemptReconnect() {
        if (this.isExplicitlyDisconnected) return;
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

        try {
            this.ws = new WebSocket(this.currentUrl);
        } catch (e) {
            console.error('WebSocket creation failed:', e);
            this.scheduleReconnect();
            return;
        }

        this.ws.onopen = (event) => {
            this.reconnectAttempts = 0;
            this.startHeartbeat();
            this.callbacks.onStatusChange(true, 'Connected');
            this.callbacks.onOpen(event);
        };

        this.ws.onmessage = (event) => {
            this.callbacks.onMessage(event);
        };

        this.ws.onerror = (error) => {
            console.warn('WebSocket error:', error);
            this.callbacks.onError(error);
            // onerror often precedes onclose, so we let onclose handle the reconnect
        };

        this.ws.onclose = (event) => {
            this.clearHeartbeat();
            this.callbacks.onStatusChange(false, 'Disconnected');
            this.callbacks.onClose(event);

            if (!this.isExplicitlyDisconnected) {
                this.scheduleReconnect();
            }
        };

        this.callbacks.onStatusChange(false, 'Connecting...');
    }

    /**
     * Disconnects the WebSocket and stops reconnection attempts.
     */
    disconnect() {
        this.isExplicitlyDisconnected = true;
        this.clearReconnectTimer();
        this.clearHeartbeat();
        if (this.ws) {
            // Remove listeners to prevent triggering close/error callbacks during intentional disconnect
            this.ws.onopen = null;
            this.ws.onmessage = null;
            this.ws.onerror = null;
            this.ws.onclose = null;
            this.ws.close();
            this.ws = null;
        }
        this.callbacks.onStatusChange(false, 'Disconnected');
    }

    /**
     * Sends data if the connection is open.
     * @param {object|string} data 
     */
    send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const payload = typeof data === 'string' ? data : JSON.stringify(data);
            this.ws.send(payload);
        } else {
            console.warn('Cannot send: WebSocket not open');
        }
    }

    /**
     * Schedules a reconnection attempt with exponential backoff.
     */
    scheduleReconnect() {
        if (this.reconnectTimer) return;
        if (this.isExplicitlyDisconnected) return;

        if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
            this.callbacks.onStatusChange(false, 'Connection lost');
            return;
        }

        const delay = Math.min(
            this.config.reconnectDelayBase * Math.pow(1.5, this.reconnectAttempts),
            10000
        );
        this.reconnectAttempts++;

        this.callbacks.onStatusChange(false, `Reconnecting (${this.reconnectAttempts})...`);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.attemptReconnect();
        }, delay);
    }

    clearReconnectTimer() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    startHeartbeat() {
        this.clearHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                try {
                    this.ws.send(JSON.stringify({ type: 'ping' }));
                } catch (e) {
                    this.scheduleReconnect();
                }
            }
        }, this.config.heartbeatInterval);
    }

    clearHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    /**
     * Helper to determine WebSocket URL from an HTTP/HTTPS address.
     * @param {string} address - format: "host:port" or "https://host"
     * @returns {string} ws:// or wss:// URL
     */
    static getWebSocketUrl(address) {
        const isSecure = window.location.protocol === 'https:' ||
            address.includes('.loca.lt') ||
            address.includes('ngrok') ||
            address.includes('trycloudflare.com');

        if (address.startsWith('ws://') || address.startsWith('wss://')) {
            return address;
        }

        const cleanAddr = address.replace(/^https?:\/\//, '');
        return `${isSecure ? 'wss' : 'ws'}://${cleanAddr}`;
    }
}
