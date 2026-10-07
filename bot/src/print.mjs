// One readable console line per journal entry.

import { rupees } from './time.mjs';

const C = process.stdout.isTTY ? { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', amber: '\x1b[33m', bold: '\x1b[1m', off: '\x1b[0m' } : { dim: '', red: '', green: '', amber: '', bold: '', off: '' };

const hhmm = (iso) => new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(11, 19);

export function printEntry(e) {
  const at = e.at ? `${C.dim}${hhmm(e.at)}${C.off} ` : '';
  switch (e.type) {
    case 'candle':
      if (e.signal || process.env.BOT_VERBOSE) console.log(`${at}${e.market} ${e.time} close ${rupees(e.c)}${e.signal ? ` ${C.amber}signal ${e.signal}${C.off}` : `  ${C.dim}${(e.blocked ?? []).join('; ')}${C.off}`}`);
      break;
    case 'skip':
      console.log(`${at}${C.dim}skip ${e.market} ${e.side}: ${e.why.join('; ')}${C.off}`);
      break;
    case 'entry':
      console.log(`${at}${C.bold}BUY ${e.qty} ${e.symbol} @ ${rupees(e.price)}${C.off}  stop ${rupees(e.stop)}  target ${rupees(e.target)}  risk ${rupees(e.risk)}`);
      break;
    case 'stop moved':
      console.log(`${at}stop ${rupees(e.from)} → ${rupees(e.to)} (${e.why})`);
      break;
    case 'exit': {
      const col = e.net >= 0 ? C.green : C.red;
      console.log(`${at}${C.bold}SELL ${e.qty} ${e.symbol} @ ${rupees(e.exit)}${C.off} (${e.reason})  ${col}net ${rupees(e.net)}${C.off} after ${rupees(e.fees)} charges, ${e.r}R  day ${rupees(e.dayNet)}`);
      break;
    }
    case 'alert':
    case 'halt':
      console.log(`${at}${C.red}${C.bold}${e.type.toUpperCase()}: ${e.message ?? e.reason}${C.off}`);
      break;
    case 'summary':
      console.log(`\n${C.bold}${e.date}: ${e.trades} trade${e.trades === 1 ? '' : 's'}, ${e.wins} won, net ${rupees(e.net)} after ${rupees(e.fees)} charges${C.off}${e.halted ? ` (stopped: ${e.halted})` : ''}`);
      break;
    case 'missed':
    case 'resume':
    case 'warm':
    case 'info':
      console.log(`${at}${C.dim}${e.type}: ${JSON.stringify({ ...e, at: undefined, type: undefined })}${C.off}`);
      break;
    default:
      break;
  }
}
