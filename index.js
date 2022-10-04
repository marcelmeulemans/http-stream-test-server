const fs = require("fs");
const express = require("express");
const pino = require("pino");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");

const app = express();

dayjs.extend(utc);

const LISTEN_PORT = 9876;
const BASE_URL = `http://127.0.0.1:${LISTEN_PORT}`;
const DATE_FORMAT = "ddd, DD MMM YYYY HH:mm:ss [GMT]";
const START_TIME = Math.floor(Date.now() / 1000) * 1000;
const STREAMS = [
  {
    width: 960,
    height: 540,
    codecs: "avc1.64001f,mp4a.40.29",
    duration: 1000,
    variance: 0,
    window: 10000,
    framerate: 60,
    bitrate: 450000,
    segments: [],
  },
  {
    width: 1920,
    height: 1080,
    codecs: "avc1.640028,mp4a.40.29",
    duration: 10000,
    variance: 1000,
    window: 120000,
    framerate: 30,
    bitrate: 2000000,
    segments: [],
  },
  {
    width: 1280,
    height: 720,
    codecs: "avc1.64001f,mp4a.40.29",
    duration: 5000,
    variance: 1000,
    window: 30000,
    framerate: 60,
    bitrate: 800000,
    segments: [],
  },
];

function getDurationInMilliseconds(start) {
  const NS_PER_SEC = 1e9;
  const NS_TO_MS = 1e6;
  const diff = process.hrtime(start);
  return Math.round(((diff[0] * NS_PER_SEC + diff[1]) / NS_TO_MS) * 100) / 100;
}

const logger = pino();
app.use((req, res, next) => {
  const start = process.hrtime();

  res.on("finish", () => {
    const method = req.method;
    const url = req.originalUrl;
    const status = res.statusCode;
    const duration = getDurationInMilliseconds(start);
    const message = `${method} ${url}`;
    const data = { status, duration };
    if (status >= 200 && status < 300) {
      logger.info(data, message);
    } else {
      logger.warn(data, message);
    }
  });

  next();
});

function makeCorsHeaders(maxAge = 0) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Max-Age": maxAge,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "origin",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };
}

function updateSegmentList(stream) {
  // Generate new segments
  let lastSegment =
    stream.segments.length > 0
      ? stream.segments[stream.segments.length - 1]
      : {
          time: START_TIME,
          duration: 0,
          index: 0,
          frames: { index: 0, count: 0 },
        };
  let missingDuration = Date.now() - (lastSegment.time + lastSegment.duration);
  while (missingDuration > 0) {
    const frameDuration = Math.round(1000 / stream.framerate);
    const framesPerSegment = Math.round(stream.duration / frameDuration);
    const framesThisSegment =
      framesPerSegment + Math.round(Math.random() * 5 - 2);
    const segment = {
      time: lastSegment.time + lastSegment.duration,
      duration: framesThisSegment * frameDuration,
      index: lastSegment.index + 1,
      frames: {
        index: lastSegment.frames.index + lastSegment.frames.count,
        count: framesThisSegment,
      },
    };
    stream.segments.push(segment);
    lastSegment = segment;
    missingDuration -= segment.duration;
  }

  // Drop segments out of window
  const windowStartTime =
    lastSegment.time + lastSegment.duration - stream.window;
  const windowStartIndex = stream.segments.findIndex(
    (segment) => segment.time >= windowStartTime
  );
  stream.segments = stream.segments.slice(windowStartIndex);
}

function encodePlaylistTags(tags = {}) {
  return Object.entries(tags).reduce(
    (acc, [key, val]) => `${acc}#${key}:${val}\n`,
    "#EXTM3U\n"
  );
}

app.get(/^\/master\.m3u8$/, function (req, res) {
  const now = dayjs.utc().format(DATE_FORMAT);
  res
    .set({
      "Last-Modified": dayjs
        .utc("2022-01-01T00:00:00.000Z")
        .format(DATE_FORMAT),
      Expires: now,
      "Cache-Control": "max-age=0, no-cache, no-store",
      Pragma: "no-cache",
      Date: now,
      "Content-Type": "application/x-mpegURL",
      ...makeCorsHeaders(),
    })
    .status(200)
    .send(
      `${encodePlaylistTags()}${STREAMS.map(
        (stream, index) =>
          `#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=${stream.bitrate},FRAME-RATE:${stream.framerate},RESOLUTION=${stream.width}x${stream.height},CODECS="${stream.codecs}"\n${BASE_URL}/stream_${index}.m3u8\n`
      ).join("")}`
    );
});

app.get(/^\/stream_([0-9]+)\.m3u8$/, function (req, res) {
  const stream = STREAMS[req.params[0]];
  if (stream) {
    updateSegmentList(stream);
    const now = dayjs.utc();
    const segments = stream.segments.filter(
      (segment) => segment.time + segment.duration <= now.valueOf()
    );

    if (segments.length > 0) {
      res
        .set({
          "Last-Modified": dayjs
            .utc(stream.segments[stream.segments.length - 1].time)
            .format(DATE_FORMAT),
          Expires: now.format(DATE_FORMAT),
          "Cache-Control": "max-age=0, no-cache, no-store",
          Pragma: "no-cache",
          Date: now.format(DATE_FORMAT),
          "Content-Type": "application/x-mpegURL",
          ...makeCorsHeaders(),
        })
        .status(200)
        .send(
          `${encodePlaylistTags({
            "EXT-X-VERSION": 3,
            "EXT-X-TARGETDURATION": stream.duration,
            "EXT-X-MEDIA-SEQUENCE": stream.segments[0].index,
            "EXT-X-PROGRAM-DATE-TIME": dayjs
              .utc(stream.segments[0].time)
              .toISOString(),
          })}${segments
            .map(
              (segment) =>
                `#EXTINF:${(segment.duration / 1000.0).toFixed(
                  3
                )},\n${BASE_URL}/stream_${req.params[0]}_${segment.index
                  .toFixed(0)
                  .padStart(5, "0")}.ts\n`
            )
            .join("")}`
        );
      return;
    }
  }

  res.status(404).end();
});

app.get(/^\/stream_([0-9]+)_([0-9]+)\.ts$/, function (req, res) {
  const stream = STREAMS[req.params[0]];
  if (stream) {
    updateSegmentList(stream);
    const segment = stream.segments.find(
      (s) => s.index === parseInt(req.params[1])
    );
    if (segment) {
      const now = dayjs.utc().format(DATE_FORMAT);
      const maxAge = 10;

      res
        .set({
          "Last-Modified": dayjs.utc(segment.time).format(DATE_FORMAT),
          Expires: now,
          "Cache-Control": `max-age=${maxAge}`,
          Pragma: "no-cache",
          Date: now,
          "Content-Type": "video/MP2T",
          ...makeCorsHeaders(maxAge),
        })
        .status(200);

      const segmentSize = Math.floor(
        (segment.duration / 1000.0) * stream.bitrate
      );
      const chunkSize = 1024;
      const buffer = Buffer.alloc(chunkSize);
      const fd = fs.openSync("/dev/urandom");

      for (
        let remaining = segmentSize, sent = 0;
        remaining > 0;
        remaining -= chunkSize, sent += chunkSize
      ) {
        fs.readSync(fd, buffer, 0, chunkSize);
        if (remaining < chunkSize) {
          res.write(buffer.subarray(0, remaining), "binary");
        } else {
          res.write(buffer, "binary");
        }
      }

      res.end(null, "binary");
      fs.closeSync(fd);

      return;
    }
  }
  res.status(404).end();
});

app.get(/^\/.*$/, function (req, res) {
  res.status(404).end();
});

app.use(function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }
  console.log(err);
  res.status(500).end();
});

app.listen(9876);
