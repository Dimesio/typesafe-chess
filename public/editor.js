// Position editor: free piece placement on the board, spare-piece trays, side to move, castling
// rights and the en-passant square. Validation lives in editor-rules.js.
import { STANDARD_FEN } from './game.js';
import { buildFen, possibleCastling, possibleEnPassant, validatePosition } from './editor-rules.js';
import { pieceEl } from './board.js';

const ROLES = ['king', 'queen', 'rook', 'bishop', 'knight', 'pawn'];
const $ = id => document.getElementById(id);

export class Editor {
  /** @param {{ cg, onDone: (fen: string) => void, onClose: () => void, orientation: () => 'white'|'black' }} options */
  constructor({ cg, onDone, onClose, orientation }) {
    this.cg = cg;
    this.onDone = onDone;
    this.onClose = onClose;
    this.orientation = orientation;
    this.active = false;
    this.turn = 'w';
    this.castling = { K: false, Q: false, k: false, q: false };
    this.ep = '-';

    $('ed-start').onclick = () => this.load(STANDARD_FEN);
    $('ed-clear').onclick = () => this.load('8/8/8/8/8/8/8/8 w - - 0 1');
    for (const r of document.querySelectorAll('input[name="ed-turn"]')) {
      r.onchange = () => { this.turn = r.value; this.sync(); };
    }
    for (const c of document.querySelectorAll('[data-castle]')) {
      c.onchange = () => { this.castling[c.dataset.castle] = c.checked; this.sync(); };
    }
    $('ed-ep').onchange = e => { this.ep = e.target.value; this.sync(); };
    $('ed-fen').onchange = e => this.load(e.target.value.trim());
    $('ed-done').onclick = () => this.done();
    $('ed-cancel').onclick = () => this.close();
  }

  open(fen) {
    this.active = true;
    this.cg.set({
      lastMove: undefined,
      check: false,
      movable: { free: true, color: 'both', dests: new Map(), showDests: false },
      draggable: { deleteOnDropOff: true },
    });
    this.cg.setAutoShapes([]);
    this.load(fen);
    this.renderTrays();
    $('editor-card').hidden = false;
    $('turn-card').hidden = true;
  }

  close() {
    this.active = false;
    this.cg.set({ movable: { free: false, showDests: true }, draggable: { deleteOnDropOff: false } });
    $('editor-card').hidden = true;
    $('turn-card').hidden = false;
    $('spare-top').hidden = true;
    $('spare-bottom').hidden = true;
    this.onClose();
  }

  /** Loads a full FEN (or just a placement) into the editor. */
  load(fen) {
    const [placement, turn = 'w', castling = '-', ep = '-'] = fen.split(/\s+/);
    if (!/^([pnbrqkPNBRQK1-8]{1,8}\/){7}[pnbrqkPNBRQK1-8]{1,8}$/.test(placement)) {
      this.showErrors(["That FEN's piece placement couldn't be read."]);
      return;
    }
    this.cg.set({ fen: placement });
    this.turn = turn === 'b' ? 'b' : 'w';
    this.castling = { K: castling.includes('K'), Q: castling.includes('Q'), k: castling.includes('k'), q: castling.includes('q') };
    this.ep = ep;
    this.sync();
  }

  /** Called after every board change: keep the options consistent with the placement. */
  sync() {
    if (!this.active) return;
    const placement = this.cg.getFen();
    const allowed = possibleCastling(placement);
    for (const c of document.querySelectorAll('[data-castle]')) {
      const k = c.dataset.castle;
      if (!allowed[k]) this.castling[k] = false;
      c.disabled = !allowed[k];
      c.checked = this.castling[k];
    }
    for (const r of document.querySelectorAll('input[name="ed-turn"]')) r.checked = r.value === this.turn;
    const eps = possibleEnPassant(placement, this.turn);
    if (!eps.includes(this.ep)) this.ep = '-';
    const select = $('ed-ep');
    select.replaceChildren(...['-', ...eps].map(sq => new Option(sq === '-' ? 'none' : sq, sq, false, sq === this.ep)));
    select.disabled = eps.length === 0;
    $('ed-fen').value = this.fen();
    this.showErrors([]);
  }

  fen() {
    return buildFen({ placement: this.cg.getFen(), turn: this.turn, castling: this.castling, ep: this.ep });
  }

  renderTrays() {
    const bottomColor = this.orientation() === 'white' ? 'w' : 'b';
    const tray = (color, el) => {
      el.replaceChildren(...ROLES.map(role => {
        const item = document.createElement('div');
        item.className = 'spare-piece';
        item.title = `Drag to add a ${color === 'w' ? 'white' : 'black'} ${role}`;
        item.append(pieceEl(color, role));
        const start = e => { e.preventDefault(); this.cg.dragNewPiece({ color: color === 'w' ? 'white' : 'black', role }, e, true); };
        item.addEventListener('mousedown', start);
        item.addEventListener('touchstart', start, { passive: false });
        return item;
      }));
      el.hidden = false;
    };
    tray(bottomColor === 'w' ? 'b' : 'w', $('spare-top'));
    tray(bottomColor, $('spare-bottom'));
  }

  showErrors(errors) {
    const ul = $('ed-errors');
    ul.replaceChildren(...errors.map(e => Object.assign(document.createElement('li'), { textContent: e })));
    ul.hidden = errors.length === 0;
  }

  done() {
    const fen = this.fen();
    const { ok, errors } = validatePosition(fen);
    if (!ok) return this.showErrors(errors);
    this.active = false;
    this.close();
    this.onDone(fen);
  }
}
