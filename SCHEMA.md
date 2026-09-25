# Il Regno di Cristallo — Schema del salvataggio v1

Il salvataggio è **un solo file JSON** (`regno-di-cristallo.json`) su Google Drive, condiviso tra i due account.
Ogni telefono ne tiene una copia completa e lavora offline; la sincronizzazione scarica, fonde e ricarica.

## Struttura

```json
{
  "schema": "regno-di-cristallo",
  "schemaVersion": 1,
  "householdId": "casa_8f2k1",
  "devices": {
    "dev_a1": { "name": "Telefono di Rocco", "lastSync": "2026-09-24T18:02:11Z", "lastSyncMark": "…" }
  },
  "data": {
    "players":  { "p1": { "id": "p1", "name": "Rocco", "_deleted": false, "_t": { "name": "…", "_deleted": "…" } } },
    "events":   { "<id>": { "date": "2026-09-26", "time": "21:00", "title": "Turno in negozio", "type": "attività", "late": true } },
    "meals":    { "2026-09-24": { "pranzo": "Insalata di farro", "cena": "Pasta zucchine e ricotta" } },
    "shopping": { "<id>": { "name": "Latte", "done": false } },
    "pantry":   { "<id>": { "name": "Zucchine", "expires": "2026-09-25" } },
    "rooms":    { "cucina": { "name": "Cucina", "icon": "🍳", "order": 3 } },
    "quests":   { "<id>": { "roomId": "cucina", "title": "Pulire il frigo", "every": 14, "last": "2026-09-04", "xp": 25 } },
    "waste":    { "umido": { "name": "Umido", "days": [1, 4] } },
    "xp":       { "xp_<timestamp>": { "player": "p1", "amount": 25, "reason": "quest:<id>", "date": "2026-09-24" } },
    "settings": { "household": { "name": "Il Regno di Cristallo" }, "late-2026-09-24": { "value": true } },
    "recipes":  { "r_<id>": { "n": "Panzerotti", "i": ["farina", "mozzarella"], "min": 60, "note": "…", "fav": true },
                  "b_3":    { "hidden": true } },
    "achievements": { "castello": { "date": "2026-09-24", "by": "p1" } },
    "log":      { "l_<id>": { "type": "spesa | usato | spreco", "name": "Latte, Pane", "count": 2, "date": "2026-09-24", "by": "p1" } }
  }
}
```

Nell'esempio i campi `id`, `_deleted` e `_t` sono mostrati solo sul primo record, ma **ogni record li ha**.

## Regole

- **Ogni record** ha `id`, i suoi campi, `_deleted` e `_t` (il timestamp di ogni campo).
- **Si fonde campo per campo**: vince il timestamp più recente. Se tu spunti il latte e l'altra persona lo rinomina, restano entrambe le modifiche.
- **Timestamp**: orologio logico ibrido `millisecondi:contatore:dispositivo`, confrontabile come stringa e robusto agli orologi dei telefoni non allineati.
- **Eliminare** vuol dire impostare `_deleted: true` (tombstone), non togliere il record: così un telefono rimasto offline non lo fa ricomparire.
- **XP** è un registro di voci che si sommano, mai un contatore: due quest completate in contemporanea contano entrambe.
- **Ricette di base** (`b_…`) vivono nel codice: nel file finiscono solo le vostre modifiche (preferita, nascosta, ingredienti).
- **Registro** (`log`): spesa portata in dispensa, oggetti usati o sprecati. Serve alla cronaca settimanale e alle imprese.
- **Quest separate dalle stanze** (con `roomId`): aggiungere una quest non tocca il record della stanza.
- **Pasti** hanno come id la data, così due persone che scrivono la cena dello stesso giorno toccano lo stesso record.
- **Migrazioni**: se `schemaVersion` cresce, l'app aggiorna il file all'apertura e non scende mai di versione.

## Pulizia

Le tombstone più vecchie di 90 giorni, e già viste da entrambi i dispositivi (`lastSync` successivo), possono essere rimosse per tenere il file leggero.
