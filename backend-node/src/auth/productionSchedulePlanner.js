const dateFormatter = (timeZone) => new Intl.DateTimeFormat('en-CA', {
  timeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function localDateParts(instant, formatter) {
  const parts = Object.fromEntries(formatter.formatToParts(instant).map(({ type, value }) => [type, value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

function dateKey({ year, month, day }) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function weekday(date) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function toUtc(date, time, timeZone) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute, second = 0] = time.split(':').map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  let result = target;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(result)).map(({ type, value }) => [type, value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second));
    const adjustment = target - represented;
    result += adjustment;
    if (adjustment === 0) return new Date(result);
  }
  throw new RangeError(`Local time ${date} ${time} does not exist in ${timeZone}.`);
}

function timeMinutes(value) {
  const [hour, minute, second = 0] = value.split(':').map(Number);
  return hour * 60 + minute + second / 60;
}

function utcDateFor(instant, timeZone) {
  return dateKey(localDateParts(instant, dateFormatter(timeZone)));
}

function sortByPriority(a, b) {
  return a.priorityRank - b.priorityRank
    || (a.deadlineUtc?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.deadlineUtc?.getTime() ?? Number.MAX_SAFE_INTEGER)
    || a.stageOrder - b.stageOrder
    || a.id.localeCompare(b.id);
}

export function planProductionSchedule({
  candidates,
  reservations,
  weeklyHours,
  holidays,
  timeZone,
  startUtc,
  horizonDays,
  workerAvailability = [],
  workerLeave = [],
}) {
  if (weeklyHours.length !== 7 || new Set(weeklyHours.map((day) => day.dayOfWeek)).size !== 7
      || weeklyHours.some((day) => day.dayOfWeek < 0 || day.dayOfWeek > 6
        || (day.isOpen && (!day.opensAt || !day.closesAt || timeMinutes(day.opensAt) >= timeMinutes(day.closesAt)))
        || (!day.isOpen && (day.opensAt || day.closesAt)))) {
    throw new RangeError('Business hours must define exactly seven valid weekdays.');
  }
  if (!Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > 366) {
    throw new RangeError('Horizon must be between 1 and 366 days.');
  }
  if (!Number.isFinite(startUtc.getTime())) throw new RangeError('Start time is invalid.');

  const taskById = new Map(candidates.map((task) => [task.id, task]));
  if (taskById.size !== candidates.length) throw new RangeError('Schedule candidate IDs must be unique.');
  const availabilityByWorker = new Map();
  for (const entry of workerAvailability) {
    const windows = availabilityByWorker.get(entry.membershipId) ?? new Map();
    if (windows.has(entry.dayOfWeek)) throw new RangeError('Only one availability window per worker and weekday is supported.');
    if (entry.dayOfWeek < 0 || entry.dayOfWeek > 6
        || (entry.isAvailable && (!entry.opensAt || !entry.closesAt
          || timeMinutes(entry.opensAt) >= timeMinutes(entry.closesAt)
          || entry.capacityMinutes < 1 || entry.capacityMinutes > 1440))
        || (!entry.isAvailable && (entry.opensAt || entry.closesAt || entry.capacityMinutes !== 0))) {
      throw new RangeError('Worker availability contains an invalid weekday window.');
    }
    windows.set(entry.dayOfWeek, entry);
    availabilityByWorker.set(entry.membershipId, windows);
  }

  const busy = [...reservations, ...workerLeave]
    .filter((reservation) => new Date(reservation.endUtc) > new Date(reservation.startUtc))
    .map((reservation) => ({
      membershipId: reservation.membershipId,
      startUtc: new Date(reservation.startUtc),
      endUtc: new Date(reservation.endUtc),
      isLeave: Boolean(reservation.isLeave),
    }));
  const scheduled = [];
  const unscheduled = new Map();
  const remaining = new Set(taskById.keys());

  while (remaining.size) {
    let madeProgress = false;
    const ordered = [...remaining].map((id) => taskById.get(id)).sort(sortByPriority);
    for (const task of ordered) {
      if (!task.assignedMembershipId) {
        unscheduled.set(task.id, 'Worker assignment is required.');
        remaining.delete(task.id); madeProgress = true; continue;
      }
      if (!Number.isInteger(task.estimatedMinutes) || task.estimatedMinutes <= 0) {
        unscheduled.set(task.id, 'A positive duration estimate is required.');
        remaining.delete(task.id); madeProgress = true; continue;
      }
      const dependencies = [...new Set(task.dependsOnTaskIds ?? [])];
      if (dependencies.some((id) => !taskById.has(id))) {
        unscheduled.set(task.id, 'A prerequisite is missing from the schedule input.');
        remaining.delete(task.id); madeProgress = true; continue;
      }
      if (dependencies.some((id) => unscheduled.has(id))) {
        unscheduled.set(task.id, 'A prerequisite could not be scheduled.');
        remaining.delete(task.id); madeProgress = true; continue;
      }
      if (dependencies.some((id) => remaining.has(id))) continue;
      const missingDependency = dependencies.some((id) => !scheduled.some((slot) => slot.taskId === id));
      if (missingDependency) {
        unscheduled.set(task.id, 'A prerequisite has no planned completion time.');
        remaining.delete(task.id); madeProgress = true; continue;
      }
      const earliest = dependencies.reduce((value, id) => {
        const dependency = scheduled.find((slot) => slot.taskId === id);
        return dependency.endUtc > value ? dependency.endUtc : value;
      }, startUtc);
      const slot = findSlot(task, earliest, weeklyHours, new Set(holidays), timeZone, horizonDays, busy, availabilityByWorker);
      if (!slot) unscheduled.set(task.id, `No available shop-hours slot found within ${horizonDays} days.`);
      else {
        scheduled.push({ taskId: task.id, startUtc: slot.startUtc, endUtc: slot.endUtc });
        busy.push({ membershipId: task.assignedMembershipId, ...slot, isLeave: false });
      }
      remaining.delete(task.id);
      madeProgress = true;
    }
    if (!madeProgress) {
      for (const id of remaining) unscheduled.set(id, 'Circular or unresolved task dependency prevents scheduling.');
      remaining.clear();
    }
  }

  scheduled.sort((a, b) => a.startUtc - b.startUtc || a.taskId.localeCompare(b.taskId));
  return { scheduled, unscheduled: [...unscheduled].map(([taskId, reason]) => ({ taskId, reason })) };
}

function findSlot(task, earliest, weeklyHours, holidays, timeZone, horizonDays, busy, availabilityByWorker) {
  const firstDate = utcDateFor(earliest, timeZone);
  const configuredDays = availabilityByWorker.get(task.assignedMembershipId);
  for (let offset = 0; offset < horizonDays; offset += 1) {
    const date = addDays(firstDate, offset);
    const dayOfWeek = weekday(date);
    const hours = weeklyHours.find((entry) => entry.dayOfWeek === dayOfWeek);
    if (!hours?.isOpen || holidays.has(date)) continue;

    let opensAt = hours.opensAt;
    let closesAt = hours.closesAt;
    const workerDay = configuredDays?.get(dayOfWeek);
    if (configuredDays) {
      if (!workerDay?.isAvailable) continue;
      if (timeMinutes(workerDay.opensAt) > timeMinutes(opensAt)) opensAt = workerDay.opensAt;
      if (timeMinutes(workerDay.closesAt) < timeMinutes(closesAt)) closesAt = workerDay.closesAt;
      if (timeMinutes(opensAt) >= timeMinutes(closesAt)) continue;
    }

    const openUtc = toUtc(date, opensAt, timeZone);
    const closeUtc = toUtc(date, closesAt, timeZone);
    let startUtc = offset === 0 && earliest > openUtc ? earliest : openUtc;
    if (startUtc >= closeUtc) continue;
    let foundConflict = true;
    while (foundConflict) {
      foundConflict = false;
      const endUtc = new Date(startUtc.getTime() + task.estimatedMinutes * 60_000);
      const conflict = busy.filter((entry) => entry.membershipId === task.assignedMembershipId
        && entry.startUtc < endUtc && entry.endUtc > startUtc)
        .sort((a, b) => a.endUtc - b.endUtc)[0];
      if (conflict) {
        startUtc = conflict.endUtc;
        foundConflict = true;
      }
    }
    const endUtc = new Date(startUtc.getTime() + task.estimatedMinutes * 60_000);
    if (endUtc > closeUtc) continue;
    if (workerDay) {
      const dayStart = toUtc(date, '00:00', timeZone);
      const dayEnd = toUtc(addDays(date, 1), '00:00', timeZone);
      const used = busy.filter((entry) => entry.membershipId === task.assignedMembershipId && !entry.isLeave
        && entry.startUtc < dayEnd && entry.endUtc > dayStart)
        .reduce((sum, entry) => sum + Math.ceil((Math.min(entry.endUtc, dayEnd) - Math.max(entry.startUtc, dayStart)) / 60_000), 0);
      if (used + task.estimatedMinutes > workerDay.capacityMinutes) continue;
    }
    return { startUtc, endUtc };
  }
  return null;
}
