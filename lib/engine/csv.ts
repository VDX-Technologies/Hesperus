// Minimal RFC 4180 reader: quoted fields, doubled quotes, CRLF or LF, a leading BOM. The
// delimiter is guessed from the header line (comma, semicolon or tab: spreadsheets in many
// locales export with ';').
export interface Csv {
  delimiter: string;
  headers: string[];
  rows: string[][];
}

const DELIMITERS = [",", ";", "\t"];

function guessDelimiter(firstLine: string): string {
  let best = ",", most = 0;
  for (const d of DELIMITERS) {
    let n = 0, quoted = false;
    for (const c of firstLine) {
      if (c === '"') quoted = !quoted;
      else if (c === d && !quoted) n++;
    }
    if (n > most) [best, most] = [d, n];
  }
  return best;
}

export function parseCsv(text: string, maxRows = Infinity, maxColumns = Infinity): Csv {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delimiter = guessDelimiter(text.slice(0, text.search(/\r?\n|$/)));
  const records: string[][] = [];
  let row: string[] = [], field = "", quoted = false, i = 0;
  const endRow = () => {
    row.push(field);
    field = "";
    if (row.length > maxColumns) throw new RangeError(`more than ${maxColumns} columns`);
    if (row.length > 1 || row[0].trim() !== "") records.push(row); // blank lines are skipped
    row = [];
    if (records.length > maxRows + 1) throw new RangeError(`more than ${maxRows} rows`);
  };
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) {
      row.push(field);
      if (row.length >= maxColumns) throw new RangeError(`more than ${maxColumns} columns`);
      field = "";
    }
    else if (c === "\n") endRow();
    else if (c !== "\r") field += c;
  }
  if (quoted) throw new SyntaxError("unterminated quoted field");
  if (field !== "" || row.length) endRow();
  const [headers = [], ...rows] = records;
  return { delimiter, headers: headers.map((h) => h.trim()), rows };
}

