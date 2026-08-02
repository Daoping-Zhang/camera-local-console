export function buildPeopleCountingPayload(event) {
  const occurredAt = event.occurredAt || formatLocalDate(new Date());
  return {
    EventNotificationAlert: {
      macAddress: event.macAddress || event.deviceKey,
      dateTime: occurredAt,
      eventType: "PeopleCounting",
      eventState: event.eventState || "active",
      channelID: Number(event.channelId || 1),
      activePostCount: Number(event.activePostCount || 1),
      peopleCounting: {
        statisticalMethods: "realTime",
        realTime: {
          time: occurredAt
        },
        enter: Number(event.enter || 0),
        exit: Number(event.exit || 0),
        duplicatePeople: Number(event.duplicatePeople || 0),
        countingSceneMode: "peopleCounting"
      }
    }
  };
}

function formatLocalDate(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("-") + " " + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join(":");
}
