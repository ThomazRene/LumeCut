import test from "node:test";
import assert from "node:assert/strict";
import { createProceduralTrack, freeTracks } from "../music-library.mjs";

test("biblioteca contém faixas livres", () => {
  assert.ok(freeTracks.length >= 3);
  assert.ok(freeTracks.every((track) => track.bpm > 0));
});

test("gera WAV válido localmente", async () => {
  const generated = createProceduralTrack("gaming");
  const header = new TextDecoder().decode((await generated.blob.arrayBuffer()).slice(0, 4));
  assert.equal(header, "RIFF");
  assert.ok(generated.blob.size > 100_000);
});
