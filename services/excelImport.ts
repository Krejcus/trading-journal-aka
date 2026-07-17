import readXlsxFile from 'read-excel-file/browser';

export const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024;
export const LEGACY_XLS_MESSAGE = 'Formát .xls není podporovaný. Otevři soubor v Excelu a ulož ho jako .xlsx.';

export function isLegacyXlsFile(fileName: string): boolean {
  return /\.xls$/i.test(fileName) && !/\.xlsx$/i.test(fileName);
}

/** Match the old sheet_to_json({ raw: false }) contract: every non-empty cell is a string. */
export function formatExcelCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (!(value instanceof Date)) return String(value);

  // Excel serial dates have no timezone. Keep their wall-clock fields instead of converting
  // to ISO (`toISOString()`), which can shift Tradovate execution time across DST/timezones.
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())} ${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`;
}

export async function readExcelRows(file: File): Promise<Record<string, string>[]> {
  if (isLegacyXlsFile(file.name)) throw new Error(LEGACY_XLS_MESSAGE);
  if (file.size > MAX_IMPORT_FILE_BYTES) throw new Error('FILE_TOO_LARGE');

  const parsedRows = await readXlsxFile(file) as unknown as unknown[][];
  const [headerRow = [], ...dataRows] = parsedRows;
  const headers = headerRow.map((value, index) => formatExcelCell(value ?? `Column ${index + 1}`).trim());

  return dataRows.flatMap(values => {
    const item: Record<string, string> = {};
    headers.forEach((header, index) => {
      item[header] = formatExcelCell(values[index]);
    });
    return Object.values(item).some(value => value !== '') ? [item] : [];
  });
}
