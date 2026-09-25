# Il Regno di Cristallo

App web installabile (PWA) per iPhone. Il codice sta su GitHub Pages, la casa sta in un file JSON privato sul vostro Google Drive. Ogni telefono ne ha una copia completa e funziona anche offline.

## Cosa c'è

| File | A cosa serve |
|---|---|
| `index.html`, `styles.css` | La pagina e lo stile bordeaux e oro |
| `app.js` | Le cinque sezioni, la sincronizzazione, i promemoria, l'Oracolo |
| `regno-sync.js` | Archivio locale e fusione delle modifiche (schema v1) |
| `drive.js` | Accesso a Google e selettore del file condiviso |
| `notify.js` | Promemoria e calendario della raccolta (.ics) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installazione su iPhone e apertura offline |
| `config.js` | Le tre chiavi di Google da compilare |

## 1. Pubblicare su GitHub Pages

1. Crea un repository `regno-di-cristallo` e carica tutti i file di questa cartella.
2. **Settings → Pages**: sorgente "Deploy from a branch", ramo `main`, cartella `/ (root)`.
3. L'indirizzo sarà `https://roccoscotellaro.github.io/regno-di-cristallo/`.

Il repository contiene solo codice: nessun dato della casa finisce su GitHub.

## 2. Configurare Google (una volta sola)

Su [console.cloud.google.com](https://console.cloud.google.com), nel progetto del Regno.

**Google Auth Platform** (menu ☰ → Google Auth Platform)
1. **Branding**: nome app "Il Regno di Cristallo", la tua email di assistenza e quella dello sviluppatore. Salva.
2. **Pubblico**:
   - tipo di utente "Esterno";
   - stato "Test";
   - in "Utenti di test" aggiungi i due account Google.
3. **Accesso ai dati**: "Aggiungi o rimuovi ambiti", cerca `drive.file`, spunta `.../auth/drive.file` e salva.
4. **Client**: "Crea client", tipo "Applicazione web".
   - Origini JavaScript autorizzate: `https://roccoscotellaro.github.io`
   - URI di reindirizzamento autorizzati: `https://roccoscotellaro.github.io/regno-di-cristallo/`

   Crea e copia l'**ID client** in `googleClientId`.

**API e servizi** (menu ☰ → API e servizi)

5. **Libreria**: abilita **Google Drive API** e **Google Picker API**.
6. **Credenziali**: "+ Crea credenziali" → "Chiave API".
   - Restrizioni applicazioni: "Siti web", aggiungi `https://roccoscotellaro.github.io/*`.
   - Restrizioni API: solo "Google Picker API".

   Copia la chiave in `googleApiKey`.

Il **numero del progetto** (Panoramica del progetto, o Impostazioni) va in `googleAppId`.

## 3. Installare sui due iPhone

1. Apri l'indirizzo in **Safari** (non Chrome).
2. **Condividi → Aggiungi alla schermata Home**.
3. Apri il Regno dall'icona:
   - **Chi fonda**: "Fonda con Google Drive", scrivi i due nomi e l'email dell'altra persona. Il file viene creato e condiviso.
   - **L'altra persona**: "Scegli il file del Regno" e seleziona `regno-di-cristallo.json` tra i file condivisi.
4. Da ⚙️ ognuno sceglie "Sono io" e può aggiungere la sua chiave API di Anthropic per l'Oracolo.
5. Da ⚙️ oppure da Casa: **"Aggiungi la raccolta al Calendario"**, così l'avviso della sera prima arriva anche a telefono bloccato.

## L'Oracolo, senza costi aggiuntivi

Da ⚙️ scegli chi risponde alle domande. Il pianificatore interno c'è sempre.

- **Pianifica la settimana da solo**: gratuito e offline.
  - Propone le cene libere, usando prima gli ingredienti in scadenza.
  - Divide le faccende in modo equo in base all'XP.
  - Mette in lista quello che manca.
- **Gemini, automatico**: gratuito con una chiave di Google AI Studio.
  1. Vai su [aistudio.google.com](https://aistudio.google.com).
  2. Apri "Get API key" e crea la chiave: non serve la carta.
  3. Incollala da ⚙️.

  Limiti del piano gratuito: un numero massimo di richieste al minuto e al giorno, e Google può usare i contenuti inviati per migliorare i suoi prodotti. Il modello si cambia in `config.js` (`geminiModel`).
- **Claude, copia e incolla**: usa il tuo abbonamento. L'app copia domanda e dati e apre Claude; poi incolli qui la risposta.

In tutti i casi le modifiche arrivano in una scheda e nulla cambia finché non tocchi "Applica al Regno".

## Altre funzioni

- **Stanze personalizzabili**: in Casa, "Modifica le stanze" permette di rinominarle, cambiare il simbolo, riordinarle e aggiungerne o toglierne.
- **Eventi settimanali**: la palestra del martedì si inserisce una volta sola. Se elimini una sola data, la serie resta.
- **Scadenze modificabili**: tocca un oggetto della dispensa per cambiarne nome e scadenza.
- **Titoli nobiliari**: l'XP della casa fa salire di rango, da Scudieri a Sovrani del Regno.
- **Sala del trono**: si apre toccando la barra dell'XP in alto e contiene:
  - la **cronaca della settimana**: quest per persona, equilibrio dei carichi, spesa, sprechi, cene decise, nuove imprese. Il lunedì arriva anche come avviso.
  - le **13 imprese** da sbloccare insieme, come Castello d'oro, Sette soli, Alleanza e Nulla va perduto.
- **Ricettario** (Spesa → Ricette):
  - 30 piatti di partenza, più quelli che aggiungete voi.
  - Ogni ricetta dice se si può fare con la dispensa o cosa manca.
  - Da una ricetta puoi metterla in programma o aggiungere i mancanti alla lista.
  - Le preferite hanno la precedenza nei suggerimenti e nel pianificatore.
  - I piatti proposti dall'Oracolo si salvano con un tocco.

## Quando sincronizza

All'apertura, 3 secondi dopo ogni modifica, ogni 5 minuti mentre è aperta, e quando torna la rete. Il pulsante in alto mostra lo stato: "in pari", "2 da inviare", "offline", "accedi".

## Limiti della versione da schermata Home

- **Notifiche**: arrivano solo con l'app aperta. Gli avvisi restano comunque in "Oggi", e la raccolta passa dal Calendario di iPhone.
- **Accesso a Google**: si rinnova ogni ora con un reindirizzamento veloce.

Entrambi i limiti spariscono con la versione nativa (Capacitor). `notify.js` usa già le notifiche locali se trova Capacitor: il codice è pronto.

## Versione nativa, più avanti

Richiede:
- un Mac con Xcode, oppure una build nel cloud (Codemagic, GitHub Actions);
- l'Apple Developer Program (99 €/anno) per installarla su entrambi gli iPhone tramite TestFlight.

Con un Apple ID gratuito l'app va reinstallata ogni 7 giorni.
