import fs from 'node:fs';

// Write beside the target, then rename over it. A crash mid-write leaves the
// previous good file intact because the rename is atomic on one filesystem.
export function atomicWriteSync(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
