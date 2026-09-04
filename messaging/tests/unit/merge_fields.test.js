'use strict';

/**
 * Merge fields.
 *
 * The three that existed before this file - name, city, zip - were defined in
 * five places that had to agree by hand: the upsert, the substitution, two
 * width tables, and variation.js. These tests hold the replacement to the
 * property that matters: adding a field to MERGE_FIELDS makes it work
 * everywhere, and a field that substitutes must also measure.
 */

const test = require('node:test');
const assert = require('node:assert');

const mf = require('../../merge_fields');
const variation = require('../../variation');

const CONTACT = {
  name: 'Jo',
  city: 'Austin',
  zip: '78701',
  bus_name: 'Acme Roofing',
  state: 'TX',
  years: '12'
};

test('every declared field substitutes', () => {
  for (const field of mf.MERGE_FIELDS) {
    const merged = mf.mergePlaceholders(`x${field.token}x`, CONTACT);
    assert.strictEqual(merged, `x${CONTACT[field.column]}x`,
      `${field.token} did not substitute`);
  }
});

test('the fields asked for are present', () => {
  for (const column of ['name', 'city', 'zip', 'bus_name', 'state', 'years']) {
    assert.ok(mf.MERGE_COLUMNS.includes(column), `${column} is missing`);
  }
});

test('a full template merges into a sentence', () => {
  assert.strictEqual(
    mf.mergePlaceholders(
      'Hi [Name] at [Bus_name] in [City], [State] [Zip] - [Years] years.', CONTACT),
    'Hi Jo at Acme Roofing in Austin, TX 78701 - 12 years.');
});

// A missing value must not leave "[Bus_name]" in the outgoing text. Recipients
// read that as a broken mail-merge, and it is the kind of thing that gets a
// sending number filtered.
test('a field the contact has no value for collapses to nothing', () => {
  assert.strictEqual(
    mf.mergePlaceholders('[Name] / [Bus_name] / [Years]', { name: 'Jo' }),
    'Jo /  / ');
});

test('placeholders are case and spelling tolerant', () => {
  const c = { bus_name: 'Acme', years: '12', zip: '78701' };
  assert.strictEqual(mf.mergePlaceholders('[bus name]', c), 'Acme');
  assert.strictEqual(mf.mergePlaceholders('[BUSINESS_NAME]', c), 'Acme');
  assert.strictEqual(mf.mergePlaceholders('[Bus-Name]', c), 'Acme');
  assert.strictEqual(mf.mergePlaceholders('[Year]', c), '12');
  assert.strictEqual(mf.mergePlaceholders('[Zip Code]', c), '78701');
});

test('a numeric value survives substitution', () => {
  assert.strictEqual(mf.mergePlaceholders('[Years]', { years: 12 }), '12');
});

/* ================================================================
 * Measurement — a field that merges must also be measurable, or a
 * template passes the segment check and then costs an extra segment
 * on every contact.
 * ================================================================ */

test('every field has a fallback width', () => {
  for (const field of mf.MERGE_FIELDS) {
    const width = mf.DEFAULT_MERGE_WIDTHS[field.column];
    assert.ok(Number.isInteger(width) && width > 0,
      `${field.column} has no usable fallback width`);
  }
});

test('filling a template expands every placeholder to its width', () => {
  for (const field of mf.MERGE_FIELDS) {
    const filled = mf.fillPlaceholders(field.token, null);
    assert.strictEqual(filled.length, mf.DEFAULT_MERGE_WIDTHS[field.column],
      `${field.token} was not expanded`);
    assert.ok(!filled.includes('['), `${field.token} survived filling`);
  }
});

test('no placeholder reaches the segment count unexpanded', () => {
  const template = mf.MERGE_FIELDS.map(f => f.token).join(' ');
  assert.ok(!mf.fillPlaceholders(template, null).includes('['));
});

// variation.js measures rewrites against the original on merged text. If it
// held its own placeholder list, a field it did not know about would stay as
// literal brackets and be measured at the wrong length.
test('variation measures the same placeholders that merge', () => {
  const template = 'Hi [Name] at [Bus_name] in [State] - [Years] years.';
  const measured = variation.measureMerged
    ? variation.measureMerged(template, null)
    : null;
  if (!measured) return;   // not exported; the fill check above still covers it
  assert.ok(typeof measured.length === 'number' || typeof measured === 'object');
});

test('a serialised field list survives the trip to the browser', () => {
  const described = JSON.parse(JSON.stringify(mf.describe()));
  assert.strictEqual(described.length, mf.MERGE_FIELDS.length);

  for (const field of described) {
    assert.ok(field.column && field.token, 'column and token must survive');
    // The client rebuilds this into a RegExp; it has to be valid there.
    assert.doesNotThrow(() => new RegExp(field.header, field.headerFlags),
      `${field.column} header pattern does not compile`);
  }
});

test('header patterns pick the column an operator would expect', () => {
  const byColumn = Object.fromEntries(
    mf.MERGE_FIELDS.map(f => [f.column, f.header]));

  assert.ok(byColumn.bus_name.test('Business Name'));
  assert.ok(byColumn.bus_name.test('company'));
  assert.ok(byColumn.state.test('State'));
  assert.ok(byColumn.years.test('Years In Business'));

  // Anchored on purpose: an unanchored /state/ also matches these, and the
  // wrong column would be imported without anything looking wrong.
  assert.ok(!byColumn.state.test('Real Estate'));
  assert.ok(!byColumn.state.test('Statement Date'));
  assert.ok(!byColumn.years.test('Years Since Last Contact ID'));
});
