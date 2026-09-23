/**
 * The CSV export (app/boss/pay/export), made safe to open in a spreadsheet.
 *
 * Every cell is quoted with its quotes doubled, which is all a CSV needs. The extra rule is about people: a
 * worker's name, a site's name and a pay note are typed by someone, and a cell that begins with =, +, -, @, a
 * tab or a carriage return is run as a formula by Excel and friends. Those get a leading apostrophe, the way OWASP
 * recommends, so they open as words. A plain number — negative ones included — is left exactly as it is.
 */
export const csvCell = (v: unknown): string => {
  const s = String(v ?? "");
  const formula = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s);
  return `"${(formula ? `'${s}` : s).replace(/"/g, '""')}"`;
};

/**
 * A download name that is safe inside a Content-Disposition header: ASCII letters, digits, space, dot, dash and
 * underscore only, at most 60 characters. A quote, a newline or a letter outside ASCII in a company name would
 * otherwise turn the download into an error. `fallback` is used when nothing usable is left.
 */
export const safeFilename = (s: string, fallback = "export"): string => {
  const cleaned = s.normalize("NFKD")
    .replace(/[\x00-\x1F\x7F]+/g, " ")           // a newline or a tab is a word break, not part of a name
    .replace(/[^\x20-\x7E]/g, "")                // accents were split off by NFKD; what is left of them, and any other script, goes
    .replace(/[^A-Za-z0-9 ._-]+/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, 60).trim();
  return cleaned || fallback;
};
