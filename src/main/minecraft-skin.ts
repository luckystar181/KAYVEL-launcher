type LookupResult = { ok: boolean; message: string; bytes?: number[]; model?: 'classic' | 'slim' };

async function limitedBody(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new Error('Empty response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (Number(response.headers.get('content-length')) > limit) throw new Error('Response too large');
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('Response too large');
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function lookupMinecraftSkin(nickname: unknown, request: typeof fetch = fetch): Promise<LookupResult> {
  if (typeof nickname !== 'string' || !/^[A-Za-z0-9_]{3,16}$/.test(nickname)) {
    return { ok: false, message: 'Введите ник Minecraft (3–16 латинских букв, цифр или _).' };
  }
  const get = (url: string) => request(url, { signal: AbortSignal.timeout(10000), redirect: 'error' });
  try {
    const player = await get(`https://api.minecraftservices.com/minecraft/profile/lookup/name/${nickname}`);
    if (player.status === 404) return { ok: false, message: 'Игрок с таким ником не найден.' };
    if (!player.ok) throw new Error('Profile lookup failed');
    const identity: unknown = JSON.parse((await limitedBody(player, 65_536)).toString('utf8'));
    const id = (identity as { id?: unknown })?.id;
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/i.test(id)) throw new Error('Invalid player id');

    const profile = await get(`https://sessionserver.mojang.com/session/minecraft/profile/${id}`);
    if (!profile.ok) throw new Error('Skin profile lookup failed');
    const data: unknown = JSON.parse((await limitedBody(profile, 65_536)).toString('utf8'));
    const properties = (data as { properties?: unknown })?.properties;
    if (!Array.isArray(properties)) throw new Error('Missing textures');
    const encoded = properties.find((property: unknown) => (property as { name?: unknown })?.name === 'textures')?.value;
    if (typeof encoded !== 'string' || encoded.length > 16000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('Invalid textures');
    const decoded: unknown = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    const skin = (decoded as { textures?: { SKIN?: { url?: unknown; metadata?: { model?: unknown } } } })?.textures?.SKIN;
    if (typeof skin?.url !== 'string') return { ok: false, message: 'У игрока нет доступного скина.' };
    const texture = new URL(skin.url);
    if (!['http:', 'https:'].includes(texture.protocol) || texture.hostname !== 'textures.minecraft.net' || texture.port || texture.username || texture.password || texture.search || texture.hash || !/^\/texture\/[a-f0-9]{32,64}$/i.test(texture.pathname)) {
      throw new Error('Untrusted texture URL');
    }
    texture.protocol = 'https:';
    const image = await get(texture.href);
    if (!image.ok || !image.headers.get('content-type')?.toLowerCase().startsWith('image/png')) throw new Error('Texture is not PNG');
    const bytes = await limitedBody(image, 1_048_576);
    if (bytes.length < 24 || ![137, 80, 78, 71, 13, 10, 26, 10].every((part, index) => bytes[index] === part)) throw new Error('Invalid PNG');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    if (width !== 64 || (height !== 64 && height !== 32)) {
      return { ok: false, message: 'Скин найден, но поддерживаются только PNG 64×64 или 64×32.' };
    }
    return { ok: true, message: 'Скин найден. Проверьте предпросмотр и нажмите «Сохранить скин».', bytes: Array.from(bytes), model: skin.metadata?.model === 'slim' ? 'slim' : 'classic' };
  } catch {
    return { ok: false, message: 'Не удалось получить скин через сервисы Minecraft. Попробуйте позже или загрузите PNG.' };
  }
}
