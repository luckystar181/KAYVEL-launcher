# Java в комплекте KAYVEL

`java.zip` — неизменённый официальный Eclipse Temurin OpenJDK JRE 21.0.13+9 для Windows x64 (HotSpot), выпускаемый Eclipse Adoptium.

Источник: https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/OpenJDK21U-jre_x64_windows_hotspot_21.0.13_9.zip

Размер: 49106397 байт.
SHA-256: `2332c0b4cff6bed722da3567c91d5e47568bcba863fa4945d0a8d6fc76158628`.

Архив распространяется целиком, без изменений. Лицензии GPLv2 с Classpath Exception, уведомления и лицензии сторонних компонентов сохранены внутри `jdk-21.0.13+9-jre/legal/` и извлекаются вместе с Java. См. также файлы NOTICE и release в официальном архиве. Исходный код и сведения о выпуске: https://github.com/adoptium/temurin21-binaries/releases/tag/jdk-21.0.13%2B9 и https://github.com/adoptium/jdk21u (tag jdk-21.0.13+9).

Для сборки заранее поместите официальный архив в `bundled/java.zip`. `npm run package:portable` проверяет размер и SHA-256 перед копированием и не скачивает Java автоматически. ZIP не хранится в Git. В готовом лаунчере отсутствующий или повреждённый архив приводит к остановке подготовки, а не к сетевому fallback.
