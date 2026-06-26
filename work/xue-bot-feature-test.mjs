import { spawn } from "node:child_process";
import path from "node:path";

const project = process.argv[2];
const port = 3117;
const dataFile = path.join(project, "..", "..", "work", `xue-bot-feature-${Date.now()}.json`);
const child = spawn(process.execPath, ["src/server.js"], {
  cwd: project,
  env: {
    ...process.env,
    PORT: String(port),
    BASE_URL: `http://localhost:${port}`,
    DATA_FILE: dataFile,
    LINE_CHANNEL_SECRET: "",
    LINE_CHANNEL_ACCESS_TOKEN: "",
    LIFF_ID: ""
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => (stdout += chunk));
child.stderr.on("data", (chunk) => (stderr += chunk));

async function waitForServer() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const response = await fetch(`http://localhost:${port}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`server did not start\nstdout=${stdout}\nstderr=${stderr}`);
}

async function json(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  return body;
}

try {
  await waitForServer();
  const base = `http://localhost:${port}`;
  const actor = { lineUserId: "tester", displayName: "測試旅伴" };
  const created = await json(`${base}/api/trips`, {
    method: "POST",
    body: { title: "宜蘭", area: "宜蘭", actor }
  });
  const tripId = created.trip.id;
  await json(`${base}/api/trips/${tripId}/itinerary`, {
    method: "POST",
    body: {
      actor,
      item: {
        type: "transport",
        title: "搭台鐵去宜蘭",
        date: "2026-07-01",
        time: "09:00",
        transportMode: "台鐵",
        transportName: "自強號",
        transportNumber: "123",
        fromPlace: "台北車站",
        toPlace: "宜蘭車站",
        boardingPlace: "台北車站 4 月台",
        duration: "1 小時 20 分",
        price: 218
      }
    }
  });
  await json(`${base}/api/trips/${tripId}/itinerary`, {
    method: "POST",
    body: {
      actor,
      item: {
        type: "lodging",
        title: "礁溪住宿",
        lodgingName: "礁溪溫泉飯店",
        checkInDate: "2026-07-01",
        checkOutDate: "2026-07-02",
        breakfast: "included",
        reservationStatus: "done",
        price: 4200
      }
    }
  });
  await json(`${base}/api/trips/${tripId}/wishes`, {
    method: "POST",
    body: { actor, wish: { type: "food", text: "想吃蔥油餅" } }
  });
  const loaded = await json(`${base}/api/trips/${tripId}?userId=tester`);
  const transport = loaded.trip.itinerary.find((item) => item.type === "transport");
  const lodging = loaded.trip.itinerary.find((item) => item.type === "lodging");
  console.log(
    JSON.stringify(
      {
        trip: loaded.trip.title,
        members: loaded.trip.members.length,
        itinerary: loaded.trip.itinerary.length,
        transport: Boolean(transport?.transportNumber && transport?.createdBy?.displayName),
        lodging: Boolean(lodging?.lodgingName && lodging?.breakfast && lodging?.updatedBy?.displayName),
        wishes: loaded.trip.wishes.length
      },
      null,
      2
    )
  );
} finally {
  child.kill();
}
