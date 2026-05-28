'use strict';

// ══════════════════════════════════════════════════════════════
//  MANIPULADOR LINEAL — Módulo de comunicación serie
//  Raspberry Pi (maestro) ↔ Arduino (esclavo)
//  Protocolo: serial 9600 baud, comandos terminados en \n
// ══════════════════════════════════════════════════════════════

const EventEmitter = require('events');

// Importación opcional de serialport (requiere compilación nativa)
let SerialPort, ReadlineParser;
try {
  ({ SerialPort } = require('serialport'));
  ({ ReadlineParser } = require('@serialport/parser-readline'));
} catch (e) {
  console.warn('[manipulator] serialport no disponible:', e.message);
}

// ── Servo real: UI y Arduino usan el mismo ángulo [0,74] ───────
const LIMITS = {
  x:     { min: 0,   max: 265 },
  y:     { min: 0,   max: 190 },
  z:     { min: 0,   max: 120 },
  servo: { min: 0,   max: 74  },
};

class ManipulatorSerial extends EventEmitter {
  constructor() {
    super();
    this.port       = null;
    this.parser     = null;
    this.connected  = false;
    this.portPath   = '';
    this.position   = { x: 0, y: 0, z: 0, servo: 36 };  // servo real; 36 = horizontal
    this.homed      = { x: false, y: false, z: false };
    this.motorOn    = false;
    this.sseClients = new Set();   // res objects for SSE
  }

  // ── SSE helpers ──────────────────────────────────────────────
  addSSEClient(res) {
    this.sseClients.add(res);
    // enviar estado actual inmediatamente
    this._sseEvent(res, 'status', this.getStatus());
  }

  removeSSEClient(res) {
    this.sseClients.delete(res);
  }

  _broadcast(type, data) {
    const payload = JSON.stringify({ type, data, ts: Date.now() });
    for (const res of this.sseClients) {
      try { res.write(`data: ${payload}\n\n`); } catch { this.sseClients.delete(res); }
    }
    this.emit(type, data);
  }

  _sseEvent(res, type, data) {
    try { res.write(`data: ${JSON.stringify({ type, data, ts: Date.now() })}\n\n`); } catch {}
  }

  // ── Lista puertos disponibles ────────────────────────────────
  async listPorts() {
    if (!SerialPort) return [];
    try { return await SerialPort.list(); } catch { return []; }
  }

  // ── Conectar al Arduino ──────────────────────────────────────
  async connect(portPath, baudRate = 9600) {
    if (!SerialPort) throw new Error('serialport no instalado. Ejecuta: npm install serialport');
    if (this.connected) await this.disconnect();

    return new Promise((resolve, reject) => {
      const sp = new SerialPort({ path: portPath, baudRate: Number(baudRate) }, (err) => {
        if (err) return reject(new Error(`No se pudo abrir ${portPath}: ${err.message}`));
      });

      sp.once('open', () => {
        this.port      = sp;
        this.portPath  = portPath;
        this.connected = true;
        this.motorOn   = true;

        this.parser = sp.pipe(new ReadlineParser({ delimiter: '\n' }));
        this.parser.on('data', (line) => this._handleLine(line.trim()));

        sp.on('error', (err) => {
          this._broadcast('error', err.message);
        });

        sp.on('close', () => {
          this.connected = false;
          this.motorOn   = false;
          this.port      = null;
          this._broadcast('status', this.getStatus());
        });

        this._broadcast('status', this.getStatus());
        resolve({ ok: true });
      });

      sp.once('error', (err) => {
        reject(new Error(`Error al conectar ${portPath}: ${err.message}`));
      });
    });
  }

  // ── Desconectar ──────────────────────────────────────────────
  disconnect() {
    return new Promise((resolve) => {
      if (this.port && this.port.isOpen) {
        this.port.close(() => resolve());
      } else {
        this.connected = false;
        resolve();
      }
    });
  }

  // ── Enviar comando al Arduino ────────────────────────────────
  sendCommand(cmd) {
    if (!this.connected || !this.port) throw new Error('No conectado al Arduino');
    const clean = String(cmd).trim().toUpperCase();
    // El panel manda el mismo ángulo real que entiende el Arduino.
    const sm = clean.match(/^S(-?\d+)$/);
    const toSend = sm
      ? `S${Math.max(LIMITS.servo.min, Math.min(LIMITS.servo.max, parseInt(sm[1], 10)))}`
      : clean;
    this.port.write(toSend + '\n');
    this._broadcast('sent', toSend);
    return toSend;
  }

  // ── Mover a posición absoluta ────────────────────────────────
  moveTo(axis, mm) {
    axis = axis.toLowerCase();
    if (!['x', 'y', 'z'].includes(axis)) throw new Error('Eje inválido');
    const delta = mm - this.position[axis];
    const cmd = `${axis.toUpperCase()}${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`;
    return this.sendCommand(cmd);
  }

  // ── Procesar línea recibida del Arduino ──────────────────────
  _handleLine(line) {
    if (!line) return;
    this._broadcast('log', line);
    this._parsePosition(line);
    this._parseState(line);
  }

  _parsePosition(line) {
    // Formato: X=265.00mm  Y=190.00mm  Z=120.00mm  Servo=55°
    const xm = line.match(/X=([\d.]+)mm/);
    const ym = line.match(/Y=([\d.]+)mm/);
    const zm = line.match(/Z=([\d.]+)mm/);
    const sm = line.match(/Servo=([\d]+)/);
    let changed = false;
    if (xm) { this.position.x     = parseFloat(xm[1]); changed = true; }
    if (ym) { this.position.y     = parseFloat(ym[1]); changed = true; }
    if (zm) { this.position.z     = parseFloat(zm[1]); changed = true; }
    if (sm) { this.position.servo = parseInt(sm[1], 10); changed = true; }
    if (changed) this._broadcast('position', { ...this.position });
  }

  _parseState(line) {
    if (line.includes('HOMEALL completo'))  { this.homed = { x: true, y: true, z: true }; }
    if (line.includes('X — ORIGEN OK'))     { this.homed.x = true; }
    if (line.includes('Y — ORIGEN OK'))     { this.homed.y = true; }
    if (line.includes('Z — ORIGEN OK'))     { this.homed.z = true; }
    if (line.includes('Motores deshabilitados')) { this.motorOn = false; this._broadcast('status', this.getStatus()); }
    if (line.includes('Motores habilitados'))    { this.motorOn = true;  this._broadcast('status', this.getStatus()); }
  }

  // ── Estado completo ──────────────────────────────────────────
  getStatus() {
    return {
      connected: this.connected,
      port:      this.portPath,
      position:  { ...this.position },
      homed:     { ...this.homed },
      motorOn:   this.motorOn,
      limits:    LIMITS,
    };
  }
}

module.exports = new ManipulatorSerial();
module.exports.LIMITS = LIMITS;
