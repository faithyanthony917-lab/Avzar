// Builds the text of a worker calendar (.ics). Shared by the signed feed link and the signed-in download.
// Appointment notes are free text that staff write about a customer; they never go into a calendar file,
// because the file leaves the system (a feed link works in any calendar app, and a download can be shared).

export const escapeIcs = (value) => String(value ?? '')
  .replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;')
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

export const icsDate = (value) => new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

export function taskIcsEvent(task) {
  return { id: task.taskId, title: task.title, start: task.startUtc, end: task.endUtc, description: `Production task (${task.status})` };
}

export function appointmentIcsEvent(appointment) {
  return {
    id: appointment.Id, title: `${appointment.Type} appointment`, start: appointment.StartUtc, end: appointment.EndUtc,
    description: 'Appointment. Open Avzar for details.',
  };
}

export function renderIcs(events, now = new Date()) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Avzar//Worker Calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const event of events) {
    lines.push('BEGIN:VEVENT', `UID:${event.id}@avzar`, `DTSTAMP:${icsDate(now)}`, `DTSTART:${icsDate(event.start)}`, `DTEND:${icsDate(event.end)}`,
      `SUMMARY:${escapeIcs(event.title)}`, `DESCRIPTION:${escapeIcs(event.description)}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}
