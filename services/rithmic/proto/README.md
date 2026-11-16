# Protobuf definice R | Protocol API

`rithmicProtoJson.ts` obsahuje protobufjs JSON (balíček `rti`, 108 zpráv) vygenerovaný
z popisovačů v knihovně `async_rithmic` 1.6.6 (16. 11. 2026). `rithmicTemplates.ts`
je tabulka `template_id` → název zprávy ze stejné knihovny.

Až bude v repu oficiální dev kit Rithmicu (.proto), porovnat a přegenerovat
z něj — knihovna může být pozadu (server posílá např. šablonu 358, kterou
tabulka nezná; klient neznámé šablony přeskakuje).
