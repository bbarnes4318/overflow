'use strict';

/**
 * The contact attributes a campaign template may merge.
 *
 * This list is the whole definition. The placeholder a template writes, the
 * conversations column it reads, the CSV header it is imported from, and the
 * width used to measure a merged message all hang off one entry - so adding a
 * field is adding a row here, not editing six places that must agree.
 *
 * They did not agree before this file existed: name, city and zip each had a
 * hand-written branch in the upsert, its own line in the substitution, its own
 * key in two separate width tables, and its own regex in variation.js. Three
 * fields, five places, and nothing forcing them to stay in step.
 *
 * `width` is the fallback used to size a template when the contact list has no
 * value to measure - a worst-case guess at how many characters the placeholder
 * becomes once it is substituted. It matters because a template cannot be
 * measured directly: "[Name]" is six characters on screen and eight GSM-7
 * units, and then becomes "Christopher" on the handset.
 */
const MERGE_FIELDS = [
  {
    column: 'name',
    token: '[Name]',
    // Accepted spellings. Case-insensitive; the token above is the canonical one.
    pattern: /\[Name\]/gi,
    // CSV headers this field is imported from.
    header: /name|contact|lead/i,
    fill: 'N',
    width: 14
  },
  {
    column: 'city',
    token: '[City]',
    pattern: /\[City\]/gi,
    header: /city/i,
    fill: 'C',
    width: 14
  },
  {
    column: 'zip',
    token: '[Zip]',
    pattern: /\[Zip(?:\s*Code)?\]/gi,
    header: /zip|postal/i,
    fill: 'Z',
    width: 5
  },
  {
    column: 'bus_name',
    token: '[Bus_name]',
    // Business name arrives spelled every possible way, and a template author
    // should not have to guess which one this app wants.
    pattern: /\[Bus(?:iness)?[_\s-]?Name\]/gi,
    header: /bus(?:iness)?[\s_-]*name|company|dba/i,
    fill: 'B',
    width: 20
  },
  {
    column: 'state',
    token: '[State]',
    pattern: /\[State\]/gi,
    // Anchored: an unanchored /state/ also matches "Real Estate" and
    // "Statement", and would silently import the wrong column.
    header: /^\s*(?:state|st|province)\s*$/i,
    fill: 'S',
    width: 2
  },
  {
    column: 'years',
    token: '[Years]',
    pattern: /\[Years?\]/gi,
    header: /^\s*years?(?:[\s_-]*(?:in[\s_-]*business|active))?\s*$/i,
    fill: 'Y',
    width: 2
  }
];

/** Column names, in template order. */
const MERGE_COLUMNS = MERGE_FIELDS.map(f => f.column);

/** The fallback widths, keyed by column - the shape variation.js expects. */
const DEFAULT_MERGE_WIDTHS = MERGE_FIELDS.reduce((acc, f) => {
  acc[f.column] = f.width;
  return acc;
}, {});

/**
 * Substitute a contact's values into a template.
 *
 * A field the contact has no value for collapses to an empty string rather than
 * leaving the raw placeholder in the outgoing message. "Hi ," reads badly; "Hi
 * [Name]," reads like a broken mail-merge, and recipients report it.
 */
function mergePlaceholders(template, contact) {
  const c = contact || {};
  let out = String(template == null ? '' : template);
  for (const field of MERGE_FIELDS) {
    out = out.replace(field.pattern, c[field.column] == null ? '' : String(c[field.column]));
  }
  return out;
}

/**
 * Replace each placeholder with a run of filler at the given width, so a
 * template can be measured as the handset will receive it.
 */
function fillPlaceholders(text, widths) {
  const w = Object.assign({}, DEFAULT_MERGE_WIDTHS, widths || {});
  let out = String(text == null ? '' : text);
  for (const field of MERGE_FIELDS) {
    const n = Math.max(0, Number(w[field.column]) || 0);
    out = out.replace(field.pattern, field.fill.repeat(n));
  }
  return out;
}

/**
 * The same list, in a shape that survives JSON.
 *
 * The browser needs it too - to map CSV headers on upload and to tell the
 * operator which placeholders exist. Sending it beats keeping a second copy in
 * app_v2.js, which would be free to drift from what the server actually
 * substitutes. A RegExp does not serialise, so its source and flags travel
 * instead and the client rebuilds it.
 */
function describe() {
  return MERGE_FIELDS.map(f => ({
    column: f.column,
    token: f.token,
    header: f.header.source,
    headerFlags: f.header.flags
  }));
}

module.exports = {
  MERGE_FIELDS,
  MERGE_COLUMNS,
  DEFAULT_MERGE_WIDTHS,
  mergePlaceholders,
  fillPlaceholders,
  describe
};
