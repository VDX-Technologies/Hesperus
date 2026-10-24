# Architettura del Core VDX

Questo documento spiega **come funziona il Core dall'inizio alla fine**, dal sensore che invia un dato fino al grafico che il cliente vede in console. È scritto per chiunque: sviluppatori nuovi, tecnici, product. Dove serve, si indicano i file da aprire per approfondire.

---

## 1. Cos'è il Core, in una frase

Il Core è una **piattaforma che riceve dati da dispositivi sul campo, li conserva, li elabora, genera allarmi e li mostra ai clienti** in una console web.

Il Core è diviso in due parti:

- **Engine**: il motore generico (`lib/engine/`). Non sa nulla di serre, sensori o settori specifici. Sa solo gestire "oggetti", "metriche", "eventi", "regole" e "allarmi".
- **Moduli (package)**: la conoscenza di settore (`lib/packages/`). Oggi esiste **LoRa**, per il monitoraggio del clima in serra. Un modulo dice all'engine che tipi di oggetti esistono, come interpretare i messaggi grezzi e quali calcoli fare.

Così l'engine resta uguale per ogni settore e per aggiungere un prodotto basta scrivere un nuovo modulo.

---

## 2. Glossario minimo

| Termine | Significato |
|---|---|
| **Organizzazione (org / tenant)** | Un cliente. Tutti i dati appartengono a un'organizzazione e sono separati da quelli degli altri clienti. |
| **Membership** | Un utente che fa parte di un'org con un ruolo: `owner`, `member` o `viewer`. |
| **Platform admin** | Una persona dello staff VDX che vede tutti i clienti. |
| **Modulo** | Un prodotto (es. `lora`) attivato per un'org (`org_modules`), con la sua configurazione (le soglie del cliente). |
| **Source** | Un canale da cui arrivano dati (es. un gateway LoRa). Ha un token segreto. |
| **Oggetto** | Una "cosa" nel mondo reale: un nodo sensore, una serra… Ha un tipo (`object_type`), delle proprietà e uno stato. |
| **Metrica** | Un numero nel tempo legato a un oggetto (es. temperatura alle 10:05 = 24,3). |
| **Rollup** | Un riassunto delle metriche per intervalli di 5 minuti o di 1 ora (min, max, media, conteggio). |
| **Evento** | Un fatto accaduto (es. "irrigazione iniziata", "allarme aperto"). |
| **Regola** | "Se la metrica X supera la soglia Y per Z secondi, apri un allarme". |
| **Allarme** | Un problema aperto su un oggetto (`object_alerts`), che si chiude da solo quando il valore torna normale. |
| **Raw** | Il messaggio originale, così com'è arrivato, prima di qualsiasi elaborazione. |

---

## 3. Il quadro generale

```
  Campo                     Core (Vercel + Supabase + R2)                     Persone
 ───────                   ──────────────────────────────                    ─────────

 Sensori ─► Gateway ──HTTPS──► POST /api/push ──► Engine (ingest)
                     Bearer token        │
                                         ├─► raw_inbox ──(ogni ora)──► R2 (archivio grezzo .jsonl.gz)
                                         │
                                         ├─► Modulo: normalize + step
                                         │
                                         ├─► objects / metrics / events      (Postgres)
                                         │
                                         └─► Regole ─► object_alerts ─┐
                                                                       │
                     pg_cron (ogni 15 min): rollup, retention,         │ Supabase Realtime
                     partizioni                                        ▼
                                                               Console web (Next.js)
                     GitHub Actions (ogni ora): flush raw,      /terra/o/[slug]  ◄── Clienti
                     health check ──► email (Resend)           /admin     ◄── Staff VDX
```

Tecnologie:

- **Next.js 16 + React 19** per la console web e le API, su **Vercel** (regione `fra1`).
- **Supabase** per login, database Postgres, sicurezza a livello di riga (RLS) e Realtime.
- **Postgres diretto** (`pg`, variabile `DATABASE_URL`) per le operazioni pesanti dell'engine.
- **Cloudflare R2** (compatibile con S3) per l'archivio dei messaggi grezzi.
- **pg_cron** dentro Postgres per la manutenzione periodica.
- **GitHub Actions** per deploy e job orari.
- **Resend** per le email di salute del sistema.

---

## 4. Clienti, utenti e sicurezza

### 4.1 Struttura

```
organizations ──< memberships >── utenti (Supabase auth)
      │
      ├──< org_modules   (quali prodotti ha, con quale config)
      └──< sources, objects, metrics, events, alerts…  (tutto ha tenant_id)
```

I luoghi fisici sono oggetti `core.site` / `core.area` collegati con `part_of` e `located_in`. Le vecchie tabelle `sites` e `zones` sono state eliminate (`20261023000000_drop_sites_zones.sql`) dopo averle spostate negli oggetti.

`platform_admins` elenca lo staff VDX.

### 4.2 Chi può fare cosa

La protezione principale è la **Row Level Security** di Postgres: ogni tabella ha regole che decidono quali righe un utente può leggere o modificare. Le regole usano funzioni di supporto:

- `is_platform_admin()`: l'utente è staff VDX?
- `org_role(org)`: che ruolo ha l'utente in quell'org?
- `can_read(org)`: è un membro qualsiasi oppure un admin.
- `can_manage(org)`: è owner oppure admin.

Un owner può modificare **solo** il campo `config` del proprio modulo (le soglie), non può attivare o disattivare prodotti.

### 4.3 I livelli di controllo nell'app

1. **`proxy.ts`** (il "middleware" di Next 16): rinnova la sessione Supabase e manda a `/login` chi non è autenticato. È solo un controllo veloce, non la vera sicurezza.
2. **`lib/auth.ts`**: `requireUser`, `requireAdmin`, `requireOrg(slug)` verificano davvero utente, ruolo e appartenenza all'org in ogni pagina e azione.
3. **RLS nel database**: l'ultima difesa.

> Attenzione: l'engine e `lib/packages/console.ts` usano il pool Postgres diretto, che **scavalca la RLS**. Per questo ogni query lì filtra sempre esplicitamente per `tenant_id`. Se scrivi una nuova query con il pool, devi farlo anche tu.

---

## 5. L'ontologia dell'engine (come sono modellati i dati)

L'engine descrive il mondo con pochi concetti generici (migrazione `supabase/migrations/20261017000000_engine_ontology.sql` e successive).

| Tabella | Cosa contiene |
|---|---|
| `object_types` | I tipi di oggetto, ciascuno di proprietà di un modulo (es. `lora.node`), con lo schema delle proprietà. Un trigger (`validate_properties`) verifica che le proprietà rispettino lo schema. |
| `objects` | Gli oggetti concreti. `properties` contiene i dati descrittivi (nome, config, ultimo frame IR…). `state` contiene lo stato di calcolo: `state.derived` per l'engine e `state.pkg` per il modulo. `last_seen` indica quando l'oggetto ha inviato dati l'ultima volta. |
| `links` | Relazioni tra oggetti. |
| `metrics` | Una riga per ogni (oggetto, metrica, istante, valore). È **partizionata per giorno**, così cancellare dati vecchi significa eliminare una partizione intera, che è velocissimo. |
| `metric_rollups` | I riassunti a 5 minuti e a 1 ora. |
| `events` + `event_objects` | Gli eventi e gli oggetti che coinvolgono. |
| `documents` | Documenti associati. |
| `sources` | I canali di ingresso (`push`, `pull`, `upload`). Il token **non è salvato in chiaro**: si salva il suo hash sha256 (`token_hash`) e solo gli ultimi caratteri (`token_hint`) per riconoscerlo. |
| `raw_inbox` | I messaggi grezzi appena arrivati, in attesa di essere archiviati su R2. |
| `rules`, `rule_state`, `object_alerts` | Regole, stato di valutazione e allarmi (vedi §7). |
| `engine_settings` | Tutti i limiti e parametri regolabili (vedi §9). |
| `engine_jobs`, `engine_usage`, `engine_notices` | Esito dei job, consumi (es. operazioni su R2) e notifiche email già inviate. |

Le vecchie tabelle (`readings`, `alerts`, `gateways`, `devices`) sono state eliminate. Oggi tutto passa dagli oggetti dell'engine.

---

## 6. Il viaggio di un dato

Questo è il cuore del sistema. Seguiamo un messaggio dal gateway fino allo schermo.

### 6.1 Arrivo: `POST /api/push`

Il gateway invia una richiesta HTTPS con l'header `Authorization: Bearer <token>` e un JSON (uno o più messaggi). Il codice è in `app/api/push/route.ts`, che chiama `ingestPush` in `lib/engine/ingest.ts`.

Controlli iniziali, in ordine:

1. L'hash del token deve corrispondere a una source esistente, altrimenti la richiesta viene rifiutata.
2. La source deve essere di tipo push e non in pausa.
3. Il modulo della source deve essere installato.
4. Il corpo non può superare 4 MB.
5. Ogni messaggio deve essere un oggetto JSON.
6. Il numero di messaggi non può superare `ingest.max_batch` (500).

### 6.2 Prima di tutto: salvare l'originale

Ogni messaggio viene scritto **subito** in `raw_inbox`, prima di qualsiasi elaborazione. Se un calcolo ha un bug, l'originale non va perso e si potrà rielaborarlo (vedi replay, §8.2).

### 6.3 Il modulo interpreta: `normalize`

L'engine registra (con una cache) i tipi di oggetto e le metriche dichiarate dal modulo (`registerPackage`). Poi passa ogni messaggio a `pkg.normalize`, che lo traduce nel linguaggio dell'engine: *"questo è l'oggetto X di tipo Y, con queste metriche a questo istante, e questi eventi"*.

Se un messaggio non è valido (`ValidationError`), viene scartato **solo quel messaggio**; gli altri del batch proseguono. Vengono rifiutate anche le misure troppo nel futuro (`ingest.max_future_s`, 300 s).

### 6.4 Oggetti e calcoli in sequenza

1. Ogni oggetto citato viene creato o aggiornato una sola volta per batch (upsert per tipo + id esterno).
2. Per ogni oggetto, **in ordine di tempo**:
   - `applyDerived` calcola le metriche derivate dichiarate dal modulo (media, somma, min, max, differenza, rapporto, delta, velocità di variazione).
   - `pkg.step` esegue la logica "con memoria" del modulo (es. contare da quante ore una foglia è bagnata).
   - Lo stato aggiornato viene salvato in `objects.state`, così il calcolo riprende da lì al messaggio successivo.

### 6.5 Scrittura

- **Metriche**: vengono inserite tutte insieme con `on conflict do nothing`. Se lo stesso dato arriva due volte, non viene duplicato: l'operazione è *idempotente*. Le metriche **non dichiarate** dal modulo non vanno in `metrics` e restano solo nell'archivio grezzo.
- **Eventi**: salvati con tipo `<modulo>.<tipo>`, ad esempio `lora.irrigation`.

### 6.6 Regole, allarmi e risposta

- Le regole vengono valutate sui nuovi punti (vedi §7). Durante un replay non vengono valutate.
- Se un dispositivo ha una configurazione più recente di quella che ha confermato (`configAck`), la nuova configurazione viene restituita nella risposta, così il gateway può aggiornarlo.
- Partono gli eventuali *alert hook* (`lib/engine/hooks.ts`), un punto di estensione pensato per un futuro livello AI. Se un hook fallisce, l'ingest non si rompe.
- `sources.last_seen` e `last_error` vengono aggiornati.

La risposta riporta: messaggi accettati e rifiutati, metriche ed eventi scritti, allarmi, configurazioni. Se **tutti** i messaggi sono stati rifiutati, lo stato è `422`.

### 6.7 Sullo schermo

La console è sottoscritta via **Supabase Realtime** alle tabelle `objects` e `object_alerts` (`components/terra/live-refresh.tsx`). Quando cambiano, la pagina si ricarica dal server con un piccolo ritardo (800 ms) per raggruppare più cambiamenti. In ogni caso si aggiorna ogni 60 secondi.

### 6.8 Un'altra porta: il caricamento di file CSV

Non tutti i dati arrivano da un gateway: i registri (raccolta, trattamenti, ...) spesso esistono già come fogli di calcolo. Una source con `connector = 'upload'` accetta file CSV caricati dalla console in `/terra/o/[slug]/upload`. Il codice è in `lib/engine/upload.ts` (`ingestUpload`) e `lib/engine/csv.ts`.

1. Solo l'**owner** dell'org può caricare. La source deve essere di tipo upload, non in pausa, e appartenere al tenant.
2. Limiti da `engine_settings`: dimensione (`upload.max_bytes`, `413`), righe (`upload.max_rows`, `413`), file al giorno per source (`upload.files_per_day`, `429`; i file rifiutati non contano).
3. Il testo viene decodificato in UTF-8, con ripiego su Windows-1252 (i CSV esportati da Excel). Il separatore (`,` `;` o tab) è riconosciuto dalla prima riga.
4. Lo stesso file (stesso hash SHA-256) non può essere caricato due volte nella stessa source: `409`.
5. Le colonne vengono tradotte con la **mappatura** salvata in `sources.config.mapping` (colonna del file → campo del modulo); i valori di `config.fixed` (es. `kind: "harvest"`) si aggiungono a ogni riga. Le colonne non mappate vengono ignorate; se nessuna colonna è mappata, `422`.
6. Ogni riga diventa un messaggio e segue **lo stesso percorso del push** (§6.2–6.6): raw, `normalize`, oggetti, metriche, eventi, regole. Una riga non valida viene rifiutata con il suo **numero di riga nel file**; le altre proseguono.
7. Il file originale viene salvato su R2 (`docs/<tenant>/<source>/<hash>-<nome>`) con una riga in `documents` (righe totali, accettate, rifiutate) e i collegamenti agli oggetti citati in `document_objects`.
8. Nel registro attività finiscono `upload.mapping` (mappatura cambiata) e `upload.file` (file caricato).

Il form legge nel browser solo l'intestazione del file, propone per ogni colonna il campo salvato o uno con lo stesso nome, e invia file e mappatura con una Server Action (limite del corpo portato a 6 MB in `next.config.ts`).

---

## 7. Regole e allarmi (`lib/engine/rules.ts`)

Una regola dice: *metrica, confronto (sopra o sotto), soglia, durata minima (`for_s`), isteresi*.

- **Famiglie e override**: le regole con la stessa chiave formano una famiglia. Una regola specifica di un oggetto sostituisce quella generale del tipo (`effectiveRules`). Così il cliente può avere soglie aziendali e, per un singolo sensore, soglie diverse.
- **Apertura**: l'allarme si apre solo se il valore resta oltre soglia **per almeno `for_s` secondi**, per evitare falsi allarmi da un singolo picco.
- **Chiusura con isteresi**: l'allarme si chiude quando il valore torna oltre `soglia ± isteresi`, per evitare che si apra e chiuda di continuo intorno alla soglia.
- Durante l'allarme viene registrato il **picco** raggiunto.
- I punti più vecchi dell'ultimo valutato (`rule_state.last_ts`) vengono ignorati, quindi i dati in ritardo non riaprono allarmi.
- Ogni apertura e chiusura genera un evento `alert.opened` / `alert.resolved`.
- Un utente può "prendere in carico" un allarme con `ack_alert()`.
- **Soglie sul dispositivo**: le regole con `push_to_device` formano una `DeviceConfig` da inviare al dispositivo. La sua versione è un hash (fnv1a) delle soglie: se le soglie cambiano, cambia la versione e il dispositivo riceve quella nuova (§6.6).

Le regole non si scrivono a mano: le genera il modulo a partire dalle impostazioni del cliente, con `upsertRules(db, tenantId, modulo, specs, objectId?)`. Succede quando l'owner salva le impostazioni (`app/terra/o/[slug]/settings/actions.ts`):

- `saveOrgSettings` salva le soglie aziendali in `org_modules.config` e rigenera le regole del tipo.
- `saveDeviceSettings` salva le soglie di un singolo oggetto in `properties.config` e crea le regole di override di quell'oggetto.

---

## 8. Archivio grezzo e replay

### 8.1 Archiviazione (`lib/engine/archive.ts`)

Ogni ora `flushRawInbox` prende i messaggi di `raw_inbox` delle **ore già concluse** e li scrive su R2 come file compressi:

```
raw/{tenant}/{source}/aaaa/mm/gg/hh.jsonl.gz
```

Garanzie:

- **Non sovrascrive mai**: se il file esiste già, ne crea uno nuovo con suffisso `-1`, `-2`… (con la condizione S3 `IfNoneMatch: "*"`).
- **Cancella da `raw_inbox` solo dopo** che il file è salvato davvero.
- Usa `for update skip locked`, quindi due flush in parallelo non si pestano i piedi.

Lo storage è astratto (`lib/engine/store.ts`):

- `S3Store` per R2.
- `MemoryStore` per i test.
- `MeteredStore`, che conta le operazioni in `engine_usage` per controllare i costi.

### 8.2 Replay (`lib/engine/replay.ts`, `scripts/replay.ts`)

Se si corregge un bug in un modulo, si possono **rielaborare** i messaggi archiviati. Il replay:

- non riscrive l'archivio grezzo;
- non genera allarmi;
- crea eventi solo con l'opzione `--events`;
- ha una modalità di prova (dry-run).

Grazie all'idempotenza, le metriche già presenti non vengono duplicate.

---

## 9. Rollup, retention e impostazioni

### 9.1 Manutenzione automatica

La funzione SQL `engine_maintenance` gira dentro Postgres con **pg_cron**, ogni `rollup.interval_min` minuti (15). Il job si crea con `engine_schedule()`. Ogni esecuzione:

1. **Calcola i rollup** a 5 minuti e a 1 ora, ripartendo da un po' prima dell'ultimo punto elaborato (`rollup.lookback_min`, 60 min) per includere i dati arrivati in ritardo.
2. **Applica la retention**: elimina le partizioni di dati grezzi più vecchie di `retention.raw_days`, ma **solo se i rollup le coprono già**, così non si perde informazione. Fa lo stesso con i rollup in base a `rollup_*_days`.
3. **Crea in anticipo** le partizioni dei prossimi giorni.

### 9.2 Lettura dei grafici (`lib/engine/query.ts`)

`series()` sceglie automaticamente la fonte in base all'intervallo richiesto:

| Intervallo del grafico | Fonte |
|---|---|
| fino a 24 ore | dati grezzi |
| fino a 7 giorni | rollup 5 minuti |
| oltre | rollup 1 ora |

### 9.3 `engine_settings`: tutti i parametri

Tutti i valori sono modificabili da `/admin/settings` senza toccare il codice.

| Chiave | Default | Significato |
|---|---|---|
| `retention.raw_days` | 14 | Giorni di metriche grezze tenuti in Postgres |
| `retention.rollup_5m_days` | 30 | Giorni di rollup a 5 minuti |
| `retention.rollup_1h_days` | null | Rollup orari (null = per sempre) |
| `rollup.interval_min` | 15 | Frequenza del job di manutenzione |
| `rollup.lookback_min` | 60 | Finestra ricalcolata per dati in ritardo |
| `metrics.partitions_ahead_days` | 3 | Partizioni create in anticipo |
| `query.raw_max_hours` | 24 | Soglia grafici: dati grezzi |
| `query.rollup_5m_max_days` | 7 | Soglia grafici: rollup 5 minuti |
| `raw.flush_interval_min` | 60 | Frequenza dell'archiviazione su R2 |
| `raw.inbox_stale_min` | 120 | Oltre questa età, il raw non archiviato è un problema |
| `quota.db_bytes` | 500 MB | Limite dimensione database |
| `quota.r2_bytes` | 10 GB | Limite spazio R2 |
| `quota.r2_writes_month` / `quota.r2_reads_month` | 1M / 10M | Operazioni R2 al mese |
| `quota.alert_ratio` | 0.8 | Avvisa all'80% di una quota |
| `health.source_silent_min` | 30 | Una source è "muta" dopo questi minuti |
| `ingest.max_batch` | 500 | Messaggi massimi per richiesta |
| `ingest.max_future_s` | 300 | Tolleranza per timestamp nel futuro |
| `alerts.email_to` | [] | Destinatari delle email di salute (vuoto = platform admin) |
| `alerts.email_from` | VDX Core | Mittente delle email di salute |
| `alerts.repeat_h` | 24 | Ogni quante ore ripetere l'email per un problema ancora aperto |
| `upload.max_bytes` | 5 MB | Dimensione massima di un file caricato |
| `upload.max_rows` | 5000 | Righe massime di un file caricato |
| `upload.files_per_day` | 50 | File caricabili in 24 ore per ogni source upload |
| `registers.types_max` | 50 | Tipi di evento che un cliente può creare nell'editor |
| `registers.export_chunk` | 500 | Righe lette per query durante un export |

---

## 10. Salute del sistema (`lib/engine/health.ts`)

Ogni ora un controllo verifica:

- **quote**: dimensione del database, spazio e operazioni su R2;
- **source mute**: source che non inviano nulla da troppo tempo;
- **inbox bloccata**: raw non archiviato da troppo tempo;
- **job falliti**.

Il risultato viene salvato in `engine_jobs` (job `health`). Agli amministratori arriva un'email (Resend) **quando un problema inizia**, di nuovo ogni `alerts.repeat_h` ore se persiste, e **quando si risolve**. Le notifiche già inviate sono tracciate in `engine_notices`, così non ci sono email doppie.

`GET /api/health` è pubblico e utile per monitor esterni: risponde `200` se tutto va bene e `503` se c'è un problema o se l'ultimo controllo ha più di 2 ore.

---

## 11. I moduli e LoRa

### 11.1 Come è fatto un modulo

Ogni modulo ha **due facce**:

**Lato engine**: `ModulePackage`, registrato in `lib/packages/index.ts`, che oggi contiene solo `[loraPackage]`. Definisce:

- `id`: es. `"lora"`;
- `objectTypes`: i tipi di oggetto e lo schema delle proprietà;
- `metrics`: le metriche dichiarate;
- `derived`: le metriche calcolate dall'engine;
- `normalize(msg)`: traduce il messaggio grezzo;
- `step(state, punto)`: la logica con memoria.

**Lato console**: `PackageDef` (`lib/packages/types.ts`, `lib/packages/ui.ts`). Definisce:

- le metriche da mostrare;
- `defaults`: i valori predefiniti delle impostazioni;
- `settings`: i campi del form;
- `presets`: configurazioni pronte;
- `validate`: controlla che le soglie siano coerenti;
- `rules(config)`: trasforma le impostazioni in regole dell'engine;
- `alertText`: il testo degli allarmi;
- `offlineAfterS`: dopo quanti secondi senza dati un dispositivo risulta offline.

In più, `components/terra/modules/registry.tsx` collega ogni modulo ai suoi componenti React: la vista panoramica (Overview) e la pagina del dispositivo (Device).

### 11.2 LoRa: clima in serra

Il modulo LoRa usa nodi sensore in serra collegati a un gateway LoRa.

**`normalize`** riceve le letture del nodo e calcola:

- **punto di rugiada** (formula di Magnus);
- **VPD** (deficit di pressione di vapore), molto importante per le piante;
- **PAR** (luce utile alla fotosintesi), stimato come lux / 54;
- dal **frame termico IR**: escursione (`spread`) e area calda (`hot_area`); l'ultimo frame viene salvato nelle proprietà per mostrarlo in console;
- `cond_margin` (quanto si è lontani dalla condensa) e `leaf_air` (differenza tra temperatura della foglia e dell'aria).

**`step`** mantiene una memoria nel tempo:

- **sospende** le regole sull'umidità durante l'irrigazione, per non generare falsi allarmi;
- conta le ore di **foglia bagnata** (`wet_h`), di **umidità alta** (`humid_h`) e le ore favorevoli alla **peronospora** (`downy_h`);
- calcola un indice di rischio **oidio** (una versione semplificata del modello Gubler-Thomas);
- calcola lo **stress giornaliero** (`stress_day`).

I valori predefiniti sono in `model.ts`; `rulesFromConfig` trasforma le soglie del cliente in regole dell'engine.

### 11.3 Records: registri da file

Il modulo `records` (`lib/packages/records/`) è generico: ogni riga di un registro è una **voce** con data (`date`), soggetto (`subject`, es. un appezzamento) e campi facoltativi (`kind`, `product`, `quantity`, `unit`, `dose`, `area`, `operator`, `note`). `normalize` legge date europee (`03/09/2026`, `3.9.26 07:30`, ISO) e numeri con virgola o punto (`1.234,5`), e rifiuta righe senza data o soggetto.

Ogni soggetto diventa un oggetto, ogni voce un evento `records.entry`; `quantity`, `dose` e `area` sono anche metriche, quindi si possono graficare. La console mostra le voci recenti per soggetto (`console.ts`, `listEntries`).

### 11.4 Agronomia: registro dei trattamenti

Il modulo `agronomy` (`lib/packages/agronomy/`) tiene tutta la conoscenza agronomica; il motore fornisce solo oggetti ed eventi manuali (`lib/engine/manual.ts`). Nessun calcolo automatico né AI: i dati li scrive l'utente.

- **Coltura** (`crop`): oggetto manuale con specie, varietà, ettari, fase fenologica, inizio/fine e `status` (`CROP_PROPERTIES`; il form usa `CROP_FORM`, senza status), collegato facoltativamente a un luogo (`located_in`). Il numero di oggetti è limitato da `objects_max` (oltre il limite: 429).
- **Pagina colture** (`/terra/o/[slug]/crops`): elenco delle attive e delle archiviate, nuova coltura, modifica con lo stesso form (`?edit=`).
  - **Modifica** (`updateManualObject`): sostituisce le proprietà ma non lo status; nell'audit `object.update` con prima e dopo.
  - **Archiviazione** (`archiveManualObject`): data di fine (quella scelta, o quella che ha, o oggi) e `status = archived`; audit `object.archive`. La coltura esce dagli elenchi attivi e dai menu di inserimento, nuovi eventi su di essa danno 409; resta leggibile nella sua pagina e nei registri.
  - **Eliminazione** (`deleteManualObject`): solo se nessun evento la cita (altrimenti 409: va archiviata); audit `object.delete`.
  - I trattamenti già registrati non cambiano mai: né modifica né archiviazione li toccano.
- **Eventi** `treatment`, `sowing`, `transplant`, `harvest`, ognuno con il proprio schema e `subject = agronomy.crop`. Il registro è quello generico (§11.5); il modulo aggiunge:
  - `fromSubject`: la scelta della coltura compila superficie e fase;
  - l'export JSON con i campi del registro ufficiale (`exports.ts`, registrato in `lib/packages/exports.ts`).
- `/terra/o/[slug]/treatments` reindirizza a `/terra/o/[slug]/registers/agronomy.treatment` (anche `?crop=` → `?obj=`).
- **Pagina coltura** (`/terra/o/[slug]/devices/[id]`): dati, timeline degli eventi e, se nell'area della coltura c'è un sensore LoRa, grafici di `rh` e `wet_h` sugli ultimi 30 giorni.

### 11.5 Registri generici (`lib/engine/registers.ts`)

Ogni tipo di evento con uno schema ha un registro, senza codice dedicato:

- **Tipi**: quelli dei pacchetti (`eventTypes`) più quelli del cliente in `event_types` con `module = 'custom'` (`listEventTypes`). Un tipo ha `fields` (schema), `subject` (tipo di oggetto: il form offre solo oggetti di quel tipo, non archiviati), `fromSubject` (campi copiati dall'oggetto scelto) e `field_order` (l'ordine dell'editor, perché jsonb non conserva l'ordine delle chiavi).
- **Editor** (`/terra/o/[slug]/registers/types`, solo owner): `saveEventType` valida la definizione (`checkEventType`), rispetta `registers.types_max` e scrive `event_type.create|update` nell'audit. Gli eventi già registrati restano come sono.
- **Registro** (`/terra/o/[slug]/registers/[type]`): form d'inserimento (`formSchema`, decimali con virgola), "ripeti ultimo", correzioni come nuove versioni, filtri `from`, `to`, `obj`, `f.<campo>` applicati dal database (`registerQuery`, contenimento jsonb).
- **Paginazione keyset**: mai offset. Il cursore è `(ts, id)` (`cursorOf`/`parseCursor`, parametro `after`), quindi le pagine non saltano né ripetono righe anche con date uguali.
- **Export** (`registers/[type]/export?format=csv|pdf|<extra>`): `allEvents` legge a blocchi di `registers.export_chunk` in ordine cronologico; il CSV è in streaming (chiavi come intestazioni, `;`, decimali con virgola, quantità in due colonne, BOM), il PDF passa da `tablePdf` (`lib/engine/pdf.ts`, pdf-lib, A4 orizzontale su più pagine). Gli export extra li dichiarano i pacchetti (`exportsOf`).
- Owner e member registrano, viewer legge; ogni scrittura va in `audit_log`.

---

## 12. La console web

### 12.1 Percorsi

| URL | Chi | Cosa |
|---|---|---|
| `/login` | tutti | accesso |
| `/` | tutti | smista: staff verso `/admin`, clienti verso `/terra/o/<slug>` |
| `/terra/o/[slug]` | membri dell'org | panoramica dei dispositivi del cliente |
| `/terra/o/[slug]/alerts` | membri | allarmi aperti e storici |
| `/terra/o/[slug]/devices/[id]` | membri | dettaglio e grafici di un dispositivo |
| `/terra/o/[slug]/registers` | membri | indice dei registri con il numero di voci |
| `/terra/o/[slug]/registers/[type]` | membri (viewer in sola lettura) | registro generico: inserimento, correzioni, filtri, pagine, export |
| `/terra/o/[slug]/registers/types` | owner | editor dei tipi di evento del cliente |
| `/terra/o/[slug]/crops` | membri (viewer in sola lettura) | colture: nuove, modifica, archiviazione, eliminazione |
| `/terra/o/[slug]/treatments` | — | reindirizza al registro `agronomy.treatment` |
| `/terra/o/[slug]/upload` | owner (gli altri vedono solo l'elenco) | caricamento di file CSV nelle source upload, ultimi file caricati |
| `/terra/o/[slug]/settings` | owner (gli altri in sola lettura) | soglie aziendali e per dispositivo |
| `/admin` | staff VDX | elenco clienti, creazione di nuove org |
| `/admin/orgs/[id]` | staff | gestione di un cliente (moduli, soglie, luoghi, membri, attività) |
| `/admin/engine` | staff | stato dell'engine (job, quote, salute) e gestione delle source (nuova source, nuovo token, pausa) |
| `/admin/settings` | staff | `engine_settings` e destinatari delle email di salute |
| `/api/push` | gateway | ingresso dati |
| `/api/health` | pubblico | stato di salute |

### 12.2 Come le pagine leggono i dati

- Le pagine sono **Server Components**: i dati si leggono sul server.
- `lib/packages/console.ts` legge oggetti, stato e allarmi tramite il pool Postgres, sempre filtrando per `tenant_id` (§4.3).
- I grafici usano `series()` (§9.2) e vengono disegnati con recharts.
- Le modifiche passano da **Server Actions** (es. `app/actions.ts`, `app/terra/o/[slug]/settings/actions.ts`). `lib/settings.ts` (`parseSettings`) converte e limita i valori dei form.
- Lingue: italiano e inglese, scelte tramite il cookie `locale`.

---

## 13. Script, job e deploy

### 13.1 Script (`scripts/`, si eseguono con `npx tsx`)

| Script | A cosa serve |
|---|---|
| `create-source.ts` | Crea una source e **stampa il token una sola volta**: va consegnato al gateway e non sarà più visibile. |
| `flush-raw.ts` | Archivia `raw_inbox` su R2. |
| `health.ts` | Esegue il controllo di salute e invia le email. |
| `replay.ts` | Rielabora l'archivio grezzo. |
| `env.ts` | Carica `.env.local` per gli script. |

### 13.2 Automazioni

- **`.github/workflows/deploy.yml`**: deploy su Vercel, in produzione per `main` e come anteprima per gli altri branch.
- **`.github/workflows/engine-hourly.yml`**: al minuto 5 di ogni ora esegue `flush-raw`, poi `health`. Health gira sempre, anche se il flush fallisce, così il fallimento viene segnalato.
- **pg_cron** (dentro Postgres): `engine_maintenance` ogni 15 minuti.

### 13.3 Variabili d'ambiente (`.env.example`)

| Variabile | Uso |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Client Supabase (login, RLS, Realtime) |
| `SUPABASE_SERVICE_ROLE_KEY` | Operazioni amministrative Supabase |
| `DATABASE_URL` | Postgres diretto (pooler sulla porta 6543) |
| `DATABASE_POOL_MAX` | Connessioni massime del pool |
| `R2_*` | Credenziali e bucket Cloudflare R2 |
| `RESEND_API_KEY` | Email di salute (in CI) |

### 13.4 Database

Lo schema vive in `supabase/migrations/` (file SQL in ordine di data). Ogni modifica allo schema è una nuova migrazione: non si modificano quelle già applicate.

---

## 14. Test

Si eseguono con `npm test` (vitest).

- `tests/engine/`: ingest, regole, archivio, health, rollup e upload CSV.
- `tests/packages/lora.test.ts`: i calcoli del modulo LoRa.
- `tests/packages/agronomy.test.ts`: colture, permessi, registro, correzioni, isolamento tra tenant, export e limiti.
- `tests/db/`: l'harness che crea un **database usa-e-getta** per ogni file di test, applicando tutte le migrazioni. Richiede un Postgres locale (`npx supabase start`) oppure `TEST_DATABASE_URL`.

I test dell'archivio usano `MemoryStore`, quindi non toccano R2.

---

## 15. Come aggiungere un nuovo modulo

1. Crea `lib/packages/<nome>/` con il `ModulePackage`: tipi di oggetto, metriche, derivate, `normalize` e, se serve, `step`.
2. Aggiungilo al registro in `lib/packages/index.ts`.
3. Crea il `PackageDef` lato console (impostazioni, default, `rules(config)`, testi degli allarmi) e registralo in `lib/packages/ui.ts`.
4. Crea i componenti Overview e Device e registrali in `components/terra/modules/registry.tsx`.
5. Scrivi i test in `tests/packages/<nome>/`.
6. Da `/admin/orgs/[id]` attiva il modulo per un cliente, poi crea una source da `/admin/engine` (oppure con `scripts/create-source.ts`).
7. Configura il gateway con il token e l'URL `/api/push`.

L'engine non va toccato: è proprio questo il suo scopo.

---

## 16. Principi da ricordare

- **L'originale non si perde mai**: prima `raw_inbox`, poi R2, senza sovrascritture.
- **Idempotenza**: inviare due volte lo stesso dato non crea duplicati.
- **Un errore non blocca tutto**: un messaggio invalido o un hook fallito non fermano il batch.
- **Separazione dei clienti**: RLS, e `tenant_id` esplicito ovunque si usi il pool diretto.
- **Engine generico, moduli specifici**: la conoscenza di settore sta solo nei package.
- **Tutto è configurabile**: i limiti stanno in `engine_settings`, non nel codice.
