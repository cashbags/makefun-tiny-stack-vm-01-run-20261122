// Tiny stack VM, make.fun tiny-stack-vm-01-run-20261122: the full ISA, byte-exact
// against the kit reference VM (generator/subject/vm.mjs). All 40 opcodes,
// traps 2-11, 1,000,000 steps, 65,536 output bytes. Deterministic.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const OC = [0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 32, 33, 34, 48, 49, 50, 51, 52, 64, 65, 80, 81, 82, 83];
const OS = '000101401010012022023033021021021021021021021011021021021011021021021021021021200210210200000011020010010001010';
const T: Record<number, [number, number, number]> = {};
OC.forEach((o, i) => { T[o] = [+OS[3 * i], +OS[3 * i + 1], +OS[3 * i + 2]]; });

/** Runs one program on its input: the bytes it wrote and its exit code. */
function run(p: Uint8Array, inp: Uint8Array): { out: Uint8Array; code: number } {
  const D = new Int32Array(256); // data stack, at most 256 values
  let sp = 0;
  const C = new Int32Array(64); // call stack, at most 64 return addresses
  let cp = 0;
  const M = new Int32Array(256); // memory, 256 words, all 0 at the start
  const out = new Uint8Array(65536);
  let ol = 0, ip = 0, pc = 0, st = 0;
  const done = (code: number) => ({ out: out.slice(0, ol), code });
  for (;;) {
    if (st === 1000000) return done(10);
    if (pc < 0 || pc >= p.length) return done(9);
    const op = p[pc];
    const t = T[op];
    if (t === undefined) return done(5);
    const [imm, pops, pushes] = t;
    if (pc + imm >= p.length) return done(9);
    st++;
    const nx = pc + 1 + imm;
    if (sp < pops) return done(2);
    if (sp - pops + pushes > 256) return done(3);
    pc = nx;
    switch (op) {
      case 0x00: return done(0); // HALT
      case 0x01: D[sp++] = (p[nx - 1] << 24) >> 24; break; // PUSH8: 0xFF is -1
      case 0x02: D[sp++] = p[nx - 4] | (p[nx - 3] << 8) | (p[nx - 2] << 16) | (p[nx - 1] << 24); break; // PUSH32
      case 0x03: sp--; break; // POP
      case 0x04: D[sp] = D[sp - 1]; sp++; break; // DUP
      case 0x05: { const x = D[sp - 1]; D[sp - 1] = D[sp - 2]; D[sp - 2] = x; break; } // SWAP
      case 0x06: D[sp] = D[sp - 2]; sp++; break; // OVER
      case 0x07: { const a = D[sp - 3]; D[sp - 3] = D[sp - 2]; D[sp - 2] = D[sp - 1]; D[sp - 1] = a; break; } // ROT
      case 0x17: D[sp - 1] = -D[sp - 1] | 0; break; // NEG wraps: -MIN is MIN
      case 0x1b: D[sp - 1] = ~D[sp - 1]; break; // NOT
      case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15:
      case 0x16: case 0x18: case 0x19: case 0x1a: case 0x1c: case 0x1d:
      case 0x1e: case 0x20: case 0x21: case 0x22: {
        const b = D[sp - 1], a = D[sp - 2];
        let r: number;
        if (op === 0x10) r = (a + b) | 0; // ADD wraps
        else if (op === 0x11) r = (a - b) | 0; // SUB wraps
        else if (op === 0x12) r = Math.imul(a, b); // MUL: low 32 bits exactly
        else if (op === 0x13) { // DIV truncated toward zero
          if (b === 0) return done(4);
          r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
        } else if (op === 0x14) { // MOD: sign of a; x % -1 is 0
          if (b === 0) return done(4);
          r = b === -1 ? 0 : (a % b) | 0;
        } else if (op === 0x15) { // DIVU: operands read unsigned
          if (b === 0) return done(4);
          r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
        } else if (op === 0x16) { // MODU: unsigned remainder, read back signed
          if (b === 0) return done(4);
          r = ((a >>> 0) % (b >>> 0)) | 0;
        } else if (op === 0x18) r = a & b;
        else if (op === 0x19) r = a | b;
        else if (op === 0x1a) r = a ^ b;
        else if (op === 0x1c) r = a << (b & 31); // shift count: low 5 bits only
        else if (op === 0x1d) r = a >> (b & 31); // SHR arithmetic
        else if (op === 0x1e) r = (a >>> (b & 31)) | 0; // SHRU logical
        else if (op === 0x20) r = a === b ? 1 : 0;
        else if (op === 0x21) r = a < b ? 1 : 0;
        else r = (a >>> 0) < (b >>> 0) ? 1 : 0; // LTU unsigned
        sp -= 2;
        D[sp++] = r;
        break;
      }
      case 0x30: case 0x31: case 0x32: { // JMP / JZ / JNZ
        const rel = ((p[nx - 2] | (p[nx - 1] << 8)) << 16) >> 16;
        let take = true;
        if (op !== 0x30) {
          const v = D[--sp];
          take = op === 0x31 ? v === 0 : v !== 0;
        }
        if (take) pc = nx + rel; // target unchecked: traps 9 at the next step
        break;
      }
      case 0x33: // CALL: 64 return addresses held already traps 7
        if (cp === 64) return done(7);
        C[cp++] = nx;
        pc = p[nx - 2] | (p[nx - 1] << 8);
        break;
      case 0x34: // RET: empty call stack traps 8
        if (cp === 0) return done(8);
        pc = C[--cp];
        break;
      case 0x40: { // LOAD: address outside 0-255 traps 6
        const addr = D[sp - 1];
        if (addr < 0 || addr >= 256) return done(6);
        D[sp - 1] = M[addr];
        break;
      }
      case 0x41: { // STORE: ( v addr -- ), address outside 0-255 traps 6
        const addr = D[sp - 1], v = D[sp - 2];
        if (addr < 0 || addr >= 256) return done(6);
        sp -= 2;
        M[addr] = v;
        break;
      }
      case 0x50: { // PRINT: decimal ASCII, no sign but '-', no newline
        const s = String(D[sp - 1]);
        if (ol + s.length > 65536) return done(11); // writes none of its bytes
        sp--;
        for (let i = 0; i < s.length; i++) out[ol++] = s.charCodeAt(i);
        break;
      }
      case 0x51: // PUTC: one byte, v AND 255
        if (ol + 1 > 65536) return done(11);
        out[ol++] = D[--sp] & 255;
        break;
      case 0x52: // IN: next input byte, -1 once the input is used up
        D[sp++] = ip < inp.length ? inp[ip++] : -1;
        break;
      case 0x53: return done(D[--sp] & 255); // EXIT: low byte of v
    }
  }
}

for (const id of readdirSync(I).sort()) {
  const r = run(
    new Uint8Array(readFileSync(join(I, id, 'program.bin'))),
    new Uint8Array(readFileSync(join(I, id, 'input.bin'))),
  );
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'stdout.bin'), r.out);
  writeFileSync(join(O, id, 'exit.txt'), `${r.code}\n`);
}
