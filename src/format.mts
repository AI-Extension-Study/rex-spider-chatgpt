// The data format: one number for the layout of every record the spider
// sends, served as data_format in the spider's config block. It goes out as
// each record's format_version, and every format after 1 has upload keys of
// its own (keys.mts), so a browser that moves to a new format sends every
// chat in its crawl window again, once, under it. A config with no
// data_format, or one that is not an integer from 1 to 999, is format 1: the
// records and keys of every build before the key existed.

export const DEFAULT_DATA_FORMAT = 1;
export const MAX_DATA_FORMAT = 999;

export const isDataFormat = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= DEFAULT_DATA_FORMAT && (value as number) <= MAX_DATA_FORMAT;

export function dataFormatOf(value: unknown): number {
  return isDataFormat(value) ? value : DEFAULT_DATA_FORMAT;
}
