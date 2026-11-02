// Escapes LIKE wildcards so a search for "50%" matches literally.
export const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// Splits a batch for multi-row statements: Postgres takes up to 65,535
// values per statement, so 1,000 rows of up to ~60 columns fit.
export const chunks = <T>(items: T[], size = 1000) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
