// Spreadsheet decoding stays on this device and off the interface thread.
// Read cached cell values only: macros, formulas and external links are not run.
importScripts('../vendor/xlsx-0.20.3.full.min.js');
self.onmessage = event => {
  try {
    const { name, buffer, fileHash } = event.data;
    const book = XLSX.read(buffer, { type: 'array', cellDates: false, cellFormula: false, cellHTML: false, bookVBA: false, bookDeps: false, dense: true, sheetRows: 50001 });
    if (book.SheetNames.length > 40) throw Error('Use a workbook with at most 40 sheets.');
    let total = 0;
    const sheets = book.SheetNames.map(name => {
      const sheet = book.Sheets[name];
      const range = XLSX.utils.decode_range(sheet['!fullref'] || sheet['!ref'] || 'A1');
      if (range.e.r >= 50000 || range.e.c >= 150) throw Error('A sheet is too large. Export only the statement or transaction table.');
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '', blankrows: true });
      total += rows.length;
      if (total > 50000) throw Error('Use a workbook with at most 50,000 rows.');
      return { name, rows };
    });
    self.postMessage({ workbook: { name, sheets, fileHash } });
  } catch (error) { self.postMessage({ error: error.message || 'The spreadsheet could not be read.' }); }
};
