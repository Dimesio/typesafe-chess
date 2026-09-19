// Worker thread for the lesson learner (server/learner.js): runs the pattern detectors on a list
// of positions and posts one result per position. Detection needs foresight up to level 3, up to
// about 180 ms per position, so a large catch-up is spread over several threads and cached.
import { parentPort, workerData } from 'node:worker_threads';
import { patternRow } from './lessons.js';

for (const fen of workerData.fens) parentPort.postMessage(patternRow(fen));
