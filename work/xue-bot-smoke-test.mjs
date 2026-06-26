import { spawn } from "node:child_process";
import path from "node:path";

const project = process.argv[2];
const port = 3107;
const dataFile = path.join(project, "..", "..", "work", `xue-bot-test-${Date.now()}.json`);
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
        title: "羅東夜市",
        place: "羅東",
        ticketStatus: "none",
        reservationStatus: "none",
        price: 500,
        currency: "TWD"
      }
    }
  });
  await json(`${base}/api/trips/${tripId}/wishes`, {
    method: "POST",
    body: { actor, wish: { type: "food", text: "想吃蔥油餅" } }
  });
  const recommendations = await json(
    `${base}/api/trips/${tripId}/recommendations?userId=tester&area=${encodeURIComponent("宜蘭")}`
  );
  const loaded = await json(`${base}/api/trips/${tripId}?userId=tester`);
  console.log(
    JSON.stringify(
      {
        health: "ok",
        trip: loaded.trip.title,
        itinerary: loaded.trip.itinerary.length,
        wishes: loaded.trip.wishes.length,
        recommendationArea: recommendations.recommendations.areaName
      },
      null,
      2
    )
  );
} finally {
  child.kill();
}
