// A minimal Server-Sent Events client over fetch(). Unlike EventSource it can
// send an Authorization header, so tokens and keys never go into URLs (where
// they end up in server and proxy logs). Reconnects with Last-Event-ID.

/**
 * openEventStream(url, { headers, onEvent(type, data), onOpen(), onError(err) })
 * returns { close() }.
 */
export function openEventStream(url, { headers = {}, onEvent = () => {}, onOpen = () => {}, onError = () => {} } = {}) {
  const controller = new AbortController();
  let lastId = null;
  let retry = 3000;
  let closed = false;

  const dispatch = (block) => {
    let type = 'message';
    const data = [];
    let id = null;
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const i = line.indexOf(':');
      const field = i === -1 ? line : line.slice(0, i);
      const value = i === -1 ? '' : line.slice(i + 1).replace(/^ /, '');
      if (field === 'event') type = value;
      else if (field === 'data') data.push(value);
      else if (field === 'id') id = value;
      else if (field === 'retry' && /^\d+$/.test(value)) retry = Number(value);
    }
    if (id !== null) lastId = id;
    if (data.length) onEvent(type, data.join('\n'));
  };

  (async () => {
    while (!closed) {
      try {
        const res = await fetch(url, {
          headers: { Accept: 'text/event-stream', ...headers, ...(lastId ? { 'Last-Event-ID': lastId } : {}) },
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!res.ok || !res.body) throw new Error(`Live feed failed (HTTP ${res.status})`);
        onOpen();
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value.replace(/\r\n?/g, '\n');
          let end;
          while ((end = buffer.indexOf('\n\n')) !== -1) {
            dispatch(buffer.slice(0, end));
            buffer = buffer.slice(end + 2);
          }
        }
        throw new Error('Live feed closed');
      } catch (err) {
        if (closed || err.name === 'AbortError') return;
        onError(err);
        await new Promise((r) => setTimeout(r, retry));
      }
    }
  })();

  return {
    close() {
      closed = true;
      controller.abort();
    },
  };
}
