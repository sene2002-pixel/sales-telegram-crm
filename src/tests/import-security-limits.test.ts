import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { assertImportPrivacy } from '../server/services/company-import-parser';

// Stored ZIP fixtures stay within import byte/expansion/ratio limits. No extraction.
function zip(entries: Record<string, string>): Buffer {
  const files: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const filename = Buffer.from(name),
      data = Buffer.from(text);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30),
      header = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    header.writeUInt32LE(0x02014b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(filename.length, 28);
    header.writeUInt32LE(offset, 42);
    files.push(local, filename, data);
    central.push(header, filename);
    offset += local.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, directory, end]);
}

function blocked(text: string): boolean {
  try {
    assertImportPrivacy(text);
    return false;
  } catch {
    return true;
  }
}

test('linear email recognition preserves unanchored ASCII privacy semantics', () => {
  const original = /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i;
  const cases = [
    'user@example.com',
    '+@a.bb',
    '_@a.bb',
    'a@..aa',
    'a@.aa',
    'a@a.b',
    'a@a.bb9',
    'a@a.bb@bad',
    'a@b@c.dd',
    'Москва user@example.com текст',
    'почта без адреса',
    'a@a_bb.cc',
    'a@a-b.cc',
    'a@a.éé',
    'a@a.Яя',
  ];
  // Deterministic differential fuzzing uses an alphabet without other banned
  // privacy terms/phone patterns, so failures specifically compare emails.
  const alphabet = 'aZ_.+-@ ';
  let state = 7142531;
  for (let sample = 0; sample < 10000; sample++) {
    let text = '';
    for (let i = 0; i < sample % 51; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      text += alphabet[state % alphabet.length];
    }
    cases.push(text);
  }
  for (const value of cases)
    assert.equal(blocked(value), original.test(value), JSON.stringify(value));
  for (const value of ['+79991234567', 'password=example', 'Bearer sample', 'паспорт', 'диагноз'])
    assert.equal(blocked(value), true, value);
});

test('maximum hostile imports reject within isolated process deadlines', () => {
  const parser = require.resolve('../server/services/company-import-parser');
  const run = (body: string) => {
    // A child deadline also bounds a regression to synchronous event-loop
    // blocking; Promise timeouts alone cannot stop the vulnerable regex.
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `
      const assert = require('node:assert/strict');
      const {assertImportPrivacy, parseCompanyImport} = require(${JSON.stringify(parser)});
      const zip = ${zip.toString()};
      (async () => { ${body} })().catch(error => { console.error(error.message); process.exitCode = 1; });
    `,
      ],
      { timeout: 5000, encoding: 'utf8', maxBuffer: 10000 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'bounded');
  };
  run(`
    for (const text of ['a'.repeat(2 * 1024 * 1024), 'a'.repeat(1000000) + '@' + 'a'.repeat(1000000)]) {
      assertImportPrivacy(text);
      await assert.rejects(parseCompanyImport(Buffer.from(text), 'txt', assertImportPrivacy), e => e.status === 400);
    }
    assert.throws(() => assertImportPrivacy('a'.repeat(1000000) + '@' + 'a'.repeat(1000000) + '.aa'), e => e.status === 400);
    console.log('bounded');
  `);
  run(`
    for (const sheet of [
      '<a'.repeat(1000000),
      '<a ' + 'x'.repeat(1900000) + '>',
      '<a x="' + 'z'.repeat(1900000) + '></a>',
      '<a>'.repeat(33) + '</a>'.repeat(33),
      '<worksheet>' + '<x/>'.repeat(25001) + '</worksheet>',
    ]) {
      const payload = zip({'xl/workbook.xml': '<workbook/>', 'xl/worksheets/sheet1.xml': sheet});
      assert.ok(payload.length < 2 * 1024 * 1024);
      await assert.rejects(parseCompanyImport(payload, 'xlsx', assertImportPrivacy), e => e.status === 400);
    }
    console.log('bounded');
  `);
});
