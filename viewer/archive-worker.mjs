const LIBARCHIVE_URL = 'https://cdn.jsdelivr.net/npm/libarchive.js@2.0.2/src/webworker/wasm-gen/libarchive.js';
const VIDEO_ENTRY = /^[A-Za-z0-9_-]+\.md$/;
const MAX_VIDEO_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const MAGIC = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];

// One request per worker. The caller can cancel immediately with terminate().
self.onmessage = async ({ data }) => {
  self.onmessage = null;
  try {
    const output = await decodeArchive(data.bytes, data.entry);
    self.postMessage({ bytes: output.buffer }, [output.buffer]);
  } catch (error) {
    self.postMessage({ error: error.message || String(error) });
  } finally {
    self.close();
  }
};

async function decodeArchive(bytes, target) {
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength < 32 || bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error('Ungültige Archivgröße.');
  }
  if (typeof target !== 'string' || !VIDEO_ENTRY.test(target)) {
    throw new Error('Ungültiger Videoeintrag.');
  }
  const input = new Uint8Array(bytes);
  if (!MAGIC.every((value, index) => input[index] === value)) {
    throw new Error('Es wird ein 7z-Kanalarchiv benötigt.');
  }

  const { default: createLibarchive } = await import(LIBARCHIVE_URL);
  const wasm = await createLibarchive({
    locateFile: name => new URL(name, LIBARCHIVE_URL).href,
  });
  const bind = (name, result, args) => wasm.cwrap(name, result, args);
  const run = {
    open: bind('archive_open', 'number', ['number', 'number', 'string', 'string']),
    next: bind('get_next_entry', 'number', ['number']),
    read: bind('get_filedata', 'number', ['number', 'number']),
    skip: bind('archive_read_data_skip', 'number', ['number']),
    close: bind('archive_close', null, ['number']),
    size: bind('archive_entry_size', 'number', ['number']),
    name: bind('archive_entry_pathname', 'string', ['number']),
    type: bind('archive_entry_filetype', 'number', ['number']),
    error: bind('archive_error_string', 'string', ['number']),
  };
  let inputPtr = 0;
  let archive = 0;
  try {
    inputPtr = wasm._malloc(input.byteLength);
    if (!inputPtr) throw new Error('Nicht genügend Speicher zum Entpacken.');
    wasm.HEAPU8.set(input, inputPtr);
    archive = run.open(inputPtr, input.byteLength, null, 'en_US.UTF-8');
    if (!archive) throw new Error('Das 7z-Archiv konnte nicht geöffnet werden.');

    let entry;
    while ((entry = run.next(archive))) {
      const name = run.name(entry);
      if (!VIDEO_ENTRY.test(name) || run.type(entry) !== 32768) {
        throw new Error('Das Archiv enthält einen ungültigen Videoeintrag.');
      }
      const size = run.size(entry);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('Ungültige Videogröße.');
      if (name !== target) {
        // libarchive skips solid predecessors internally. Never allocate their data.
        if (run.skip(archive) < 0) throw new Error(run.error(archive) || 'Video konnte nicht übersprungen werden.');
        continue;
      }
      if (size > MAX_VIDEO_BYTES) throw new Error('Das ausgewählte Video ist zu groß.');
      const output = new Uint8Array(size);
      for (let offset = 0; offset < size;) {
        const count = Math.min(CHUNK_BYTES, size - offset);
        const chunkPtr = run.read(archive, count);
        if (chunkPtr <= 0) throw new Error(run.error(archive) || 'Video konnte nicht entpackt werden.');
        try {
          output.set(wasm.HEAPU8.subarray(chunkPtr, chunkPtr + count), offset);
        } finally {
          wasm._free(chunkPtr);
        }
        offset += count;
      }
      return output;
    }
    throw new Error(run.error(archive) || 'Das Video ist nicht im Kanalarchiv enthalten.');
  } finally {
    if (archive) run.close(archive);
    if (inputPtr) wasm._free(inputPtr);
  }
}
