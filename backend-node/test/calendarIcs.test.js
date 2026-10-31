import test from 'node:test';
import assert from 'node:assert/strict';
import { appointmentIcsEvent, escapeIcs, icsDate, renderIcs, taskIcsEvent } from '../src/auth/calendarIcs.js';

const appointment = {
  Id: 'a1', Type: 'Fitting', StartUtc: '2026-11-02T09:00:00.000Z', EndUtc: '2026-11-02T09:45:00.000Z',
  Notes: 'Customer is nervous about the wedding; allergic to wool',
};

test('an appointment calendar entry never carries the staff notes', () => {
  const event = appointmentIcsEvent(appointment);
  assert.equal(event.title, 'Fitting appointment');
  assert.doesNotMatch(JSON.stringify(event), /nervous|wool|wedding/);
  const text = renderIcs([event], new Date('2026-10-26T10:00:00Z'));
  assert.doesNotMatch(text, /nervous|wool|wedding|Notes/i);
  assert.match(text, /SUMMARY:Fitting appointment/);
  assert.match(text, /DESCRIPTION:Appointment\. Open Avzar for details\./);
});

test('renderIcs writes a valid calendar with CRLF line ends, UTC times and one event per entry', () => {
  const task = { taskId: 't1', title: 'Cut agbada, size L', status: 'Scheduled', startUtc: '2026-11-03T08:00:00Z', endUtc: '2026-11-03T10:30:00Z' };
  const text = renderIcs([taskIcsEvent(task), appointmentIcsEvent(appointment)], new Date('2026-10-26T10:00:00Z'));
  assert.ok(text.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'));
  assert.ok(text.endsWith('END:VCALENDAR\r\n'));
  assert.equal((text.match(/BEGIN:VEVENT/g) ?? []).length, 2);
  assert.match(text, /UID:t1@avzar/);
  assert.match(text, /DTSTART:20261103T080000Z/);
  assert.match(text, /DTSTAMP:20261026T100000Z/);
  assert.match(text, /SUMMARY:Cut agbada\\, size L/);
  assert.match(text, /DESCRIPTION:Production task \(Scheduled\)/);
  assert.doesNotMatch(text.replace(/\r\n/g, ''), /[\r\n]/);
});

test('escapeIcs escapes separators and drops control characters', () => {
  assert.equal(escapeIcs('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne');
  assert.equal(escapeIcs('x\u0000y\u0007z'), 'xyz');
  assert.equal(escapeIcs(null), '');
  assert.equal(icsDate('2026-01-02T03:04:05.678Z'), '20260102T030405Z');
});

test('an empty calendar is still a valid calendar', () => {
  assert.equal(renderIcs([], new Date('2026-10-26T10:00:00Z')), 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Avzar//Worker Calendar//EN\r\nCALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\nEND:VCALENDAR\r\n');
});
