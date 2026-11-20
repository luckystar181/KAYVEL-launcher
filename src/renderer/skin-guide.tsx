import React, { useEffect, useRef, useState } from 'react';

type GuideLink = 'postimages' | 'modrinth' | 'commands';

const commands = {
  classic: '/skin set web classic "https://i.postimg.cc/XXXX/skin.png"',
  slim: '/skin set web slim "https://i.postimg.cc/XXXX/skin.png"'
};

export function SkinGuide({ lang, onClose }: { lang: 'ru' | 'en'; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [linkError, setLinkError] = useState(false);
  const ru = lang === 'ru';
  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current!;
    element.showModal();
    return () => {
      element.close();
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  async function openLink(link: GuideLink) {
    setLinkError(false);
    try {
      const result = await window.kayvel.openGuideLink(link);
      if (!result.ok) setLinkError(true);
    } catch { setLinkError(true); }
  }
  return <dialog ref={dialog} className="skin-guide game-dialog" aria-labelledby="skin-guide-title" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => {
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
  }}>
    <div className="game-dialog-head"><div><span className="eyebrow">KAYVEL / SKIN RESTORER</span><h2 id="skin-guide-title">{ru ? 'Как установить скин на сервере' : 'How to set your server skin'}</h2></div><button autoFocus className="game-close" aria-label={ru ? 'Закрыть гайд' : 'Close guide'} onClick={onClose}>×</button></div>
    <div className="skin-guide-body">
      <p className="skin-guide-intro">{ru ? 'Скин задаётся командой на сервере, а не через локальный профиль лаунчера. Skin Restorer должен быть установлен администратором на сервере; игроку не нужно скачивать его в клиент.' : 'Set your skin with a server command, not in the local launcher profile. An administrator must install Skin Restorer on the server; players do not need to download it to their client.'}</p>
      <ol className="skin-guide-steps">
        <li><h3>{ru ? 'Подготовьте PNG скина' : 'Prepare your skin PNG'}</h3><p>{ru ? 'Нужна именно текстура скина Minecraft, обычно 64×64 пикселя, а не скриншот персонажа. Выберите модель: Classic / Steve — широкие руки, Slim / Alex — узкие.' : 'Use a Minecraft skin texture, usually 64×64 pixels, not a character screenshot. Choose the model: Classic / Steve has wide arms; Slim / Alex has narrow arms.'}</p></li>
        <li><h3>{ru ? 'Загрузите файл на Postimages' : 'Upload the file to Postimages'}</h3><p>{ru ? 'Откройте хостинг, выберите PNG, отключите изменение размера («Не изменять размер») и установите «Без срока удаления». Загружайте только сам скин: файл станет доступен по публичной ссылке.' : 'Open the hosting site, choose your PNG, select “Do not resize my image” and “No expiration”. Upload only the skin itself: the file will be accessible through a public link.'}</p><button className="guide-link" data-guide-link="postimages" onClick={() => void openLink('postimages')}>{ru ? 'Открыть Postimages' : 'Open Postimages'} ↗</button></li>
        <li><h3>{ru ? 'Скопируйте прямую ссылку' : 'Copy the direct link'}</h3><p>{ru ? 'После загрузки возьмите «Прямая ссылка» / “Direct link”. Она должна вести к самому PNG на i.postimg.cc, а не к странице просмотра на postimg.cc. Откройте ссылку в браузере: должна отображаться только текстура.' : 'After uploading, copy “Direct link”. It must point to the PNG itself on i.postimg.cc, not a postimg.cc viewer page. Open it in a browser to check: only the texture should appear.'}</p><p>{ru ? 'Один адрес https://i.postimg.cc без пути к файлу не подойдёт.' : 'The address https://i.postimg.cc alone, without a file path, will not work.'}</p></li>
        <li><h3>{ru ? 'Введите команду в чате сервера' : 'Enter the command in server chat'}</h3><p>{ru ? 'Зайдите на сервер KAYVEL. Нажмите T, вставьте подходящую команду, замените пример URL своей полной прямой ссылкой и нажмите Enter. Кавычки вокруг ссылки оставьте.' : 'Join the KAYVEL server. Press T, paste the matching command, replace the example URL with your complete direct link and press Enter. Keep the quotes around the link.'}</p><div className="skin-guide-command"><strong>Classic / Steve</strong><code>{commands.classic}</code></div><div className="skin-guide-command"><strong>Slim / Alex</strong><code>{commands.slim}</code></div><small>{ru ? 'XXXX/skin.png — пример, а не готовый скин. Команду выполняете вы в игре; лаунчер ничего не отправляет на сервер.' : 'XXXX/skin.png is a placeholder, not a real skin. You run the command in-game; the launcher sends nothing to the server.'}</small></li>
      </ol>
      <section className="skin-guide-help"><h3>{ru ? 'Если скин не появился' : 'If the skin does not appear'}</h3><p>{ru ? 'Дождитесь ответа команды. Проверьте прямую ссылку, PNG и выбранную модель. При необходимости переподключитесь к серверу. Если /skin неизвестна, нет прав или сервис временно недоступен — обратитесь к администратору; не удаляйте моды, конфиги или старые PNG наугад.' : 'Wait for the command response. Check the direct link, PNG and selected model. Rejoin the server if needed. If /skin is unknown, access is denied or the service is temporarily unavailable, contact an administrator; do not delete mods, configs or old PNGs at random.'}</p></section>
      <div className="skin-guide-links"><button className="guide-link" data-guide-link="modrinth" onClick={() => void openLink('modrinth')}>Skin Restorer · Modrinth 1.21.1 ↗</button><button className="guide-link" data-guide-link="commands" onClick={() => void openLink('commands')}>{ru ? 'Документация команд' : 'Command documentation'} ↗</button></div>
      <p className="skin-guide-note">{ru ? 'Ссылки открываются во внешнем браузере только по нажатию. Этот гайд не загружает изображения, не устанавливает моды и не меняет файлы игры или профиль.' : 'Links open in your external browser only when clicked. This guide does not upload images, install mods or change game files or your profile.'}</p>
      {linkError && <p role="alert">{ru ? 'Не удалось открыть браузер. Адреса: https://postimages.org/ · https://modrinth.com/mod/skinrestorer?g=1.21.1 · https://github.com/Suiranoil/SkinRestorer/wiki/Commands' : 'Could not open the browser. Addresses: https://postimages.org/ · https://modrinth.com/mod/skinrestorer?g=1.21.1 · https://github.com/Suiranoil/SkinRestorer/wiki/Commands'}</p>}
    </div>
  </dialog>;
}
