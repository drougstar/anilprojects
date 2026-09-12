// File bytes are passed only to a local worker. No conversion service receives them.
export async function readBankFiles(files, { signal, onProgress = () => {} } = {}) {
  files = [...files];
  if (!files.length || files.length > 30) throw Error('Choose between 1 and 30 Excel files.');
  if (files.some(file => !/\.xlsx?$/i.test(file.name))) throw Error('Choose Excel .xls or .xlsx files. Use Import spending for CSV.');
  if (files.some(file => file.size > 10 * 1024 * 1024) || files.reduce((sum, file) => sum + file.size, 0) > 50 * 1024 * 1024) throw Error('Use files below 10 MB each and 50 MB in total.');
  let worker;
  const check = () => { if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError'); };
  const output = [];
  try {
    for (const [index, file] of files.entries()) {
      check(); onProgress(index, files.length, file.name);
      const buffer = await file.arrayBuffer(); check();
      const hash = await crypto.subtle.digest('SHA-256', buffer); check();
      const fileHash = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      const workbook = await new Promise((resolve, reject) => {
        // Attach error handlers in the same turn that starts the worker.
        worker ||= new Worker(new URL('./bank-reader-worker.js', import.meta.url));
        const cleanup = () => { clearTimeout(timer); worker.removeEventListener('message', message); worker.removeEventListener('error', error); signal?.removeEventListener('abort', abort); };
        const message = event => { cleanup(); event.data.error ? reject(Error(`${file.name}: ${event.data.error}`)) : resolve(event.data.workbook); };
        const error = () => { cleanup(); reject(Error('The Excel reader could not start. Reload the app and try again.')); };
        const abort = () => { cleanup(); reject(new DOMException('Import cancelled.', 'AbortError')); };
        const timer = setTimeout(() => { cleanup(); worker.terminate(); reject(Error(`${file.name}: reading took too long. Export a smaller transaction table.`)); }, 30000);
        worker.addEventListener('message', message); worker.addEventListener('error', error); signal?.addEventListener('abort', abort, { once: true });
        worker.postMessage({ name: file.name, buffer, fileHash }, [buffer]);
      });
      check(); output.push(workbook);
    }
    return output;
  } finally { worker?.terminate(); }
}
