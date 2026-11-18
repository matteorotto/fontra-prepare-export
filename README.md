# Prepara per l'export

Plugin per [Fontra](https://fontra.xyz). Prima di esportare il font controlla tutto il font e sistema i tracciati, come faceva Glyphs in fase di export:

- **unisce i tracciati sovrapposti**: le forme di costruzione diventano una forma sola, in tutti i master;
- **toglie i punti doppi**, cioè due punti uno sopra l'altro;
- **arrotonda le coordinate** dei punti a numeri interi;
- **segnala quello che va sistemato a mano**: sovrapposizioni che non si possono unire, master che non si corrispondono, contorni aperti, componenti mancanti, Unicode doppi, nomi non validi, glifi che non finiranno nel font…

Non cambia niente finché non premi **Applica**, e tutto si annulla con ⌘Z.

Dopo l'export, **riordina i glifi del font esportato** come li ordinerebbe Glyphs, così nel pannello Glifi di Illustrator non sono più in ordine alfabetico per nome.

## Installazione

In Fontra: **Fontra → Plugin Manager → +**, e incolla:

```
https://cdn.jsdelivr.net/gh/<utente>/fontra-prepare-export@v1.1.0
```

Poi ricarica l'editor. Per aggiornare a una versione nuova togli l'indirizzo vecchio, aggiungi quello nuovo e ricarica.

Come gli altri plugin, le funzioni compaiono nella panoramica del font dopo che hai aperto un glifo da lì (oppure dopo aver aperto la panoramica dal menu Font dell'editor).

## Come si usa

1. **Fai una copia del font**: **File → Esporta come → .fontra**, poi apri la copia. Il plugin cambia i tracciati di tutto il font: l'originale, con le forme di costruzione, deve restare com'è.
2. Nella **panoramica** della copia: **File → Prepara per l'export…**. Il plugin controlla tutti i glifi e prova a unire i tracciati in ogni master. Su DIESEL V2 (544 glifi, 9 master) ci mette circa 8 secondi.
3. Guarda il resoconto e scegli cosa sistemare. Spunta **«Sto lavorando su una copia del font»** e premi **Applica**.
4. Esporta con **File → Esporta come → OpenType (.otf)**.

Nell'editor c'è **File → Controlla il font per l'export…**: fa lo stesso controllo ma non cambia niente, quindi puoi usarlo anche sul font originale. Cliccando un glifo, la finestra si fa da parte e il glifo si apre. Il bottone blu **↩ Resoconto per l'export**, in basso a destra, la riporta.

## Il resoconto

### Da sistemare in automatico

| Correzione | Cosa fa |
|---|---|
| **Unisci i tracciati sovrapposti** | Unisce le forme che si sovrappongono, in tutti i master. La forma che vedi non cambia. Se un componente si sovrappone al disegno (per esempio la H fatta con due componenti I e un tratto orizzontale), il glifo viene scomposto e poi unito. |
| **Togli i punti doppi** | Toglie i punti che stanno uno sopra l'altro, ma solo se sono doppi nello stesso posto in tutti i master. |
| **Arrotonda le coordinate** | Porta a numeri interi i punti con i decimali. |

Ogni correzione si può spegnere. Tutte insieme sono un solo passo, che si annulla con ⌘Z.

### Da sistemare a mano

Queste cose il plugin non le cambia. Clicca il nome di un glifo per aprirlo. Clicca i nomi dei master (in blu) per aprire il glifo proprio in quel master.

- **Sovrapposizioni che non si possono unire.** In un font variabile i master devono avere gli stessi contorni e gli stessi punti, nello stesso ordine. In alcuni glifi l'unione dà forme diverse da un master all'altro, e il font non si potrebbe più interpolare. Di solito il motivo è che due forme quasi combaciano: in un master i bordi si incrociano, in un altro si toccano appena o restano staccati. Il plugin dice dove guardare, nelle coordinate di quel master. Per esempio, nella A di DIESEL: «Bold Compact, Bold, Bold Wide: qui le forme si incrociano in 362, 627, negli altri master no». Questi glifi restano con le sovrapposizioni: il font funziona lo stesso, ma convertendo il testo in tracciati le forme di costruzione si vedono. Allinea i bordi, oppure falli sovrapporre di più, nei master indicati, poi premi **Ricontrolla**.
- **Master che non si corrispondono**: contorni, punti o componenti diversi tra i master. Finché non corrispondono, l'export del font variabile si ferma con un errore.
- **Punti doppi solo in alcuni master.**
- **Contorni aperti.**
- **Componenti di glifi che non esistono.**
- **Unicode usati da più glifi.**
- **Nomi di glifo non validi.**
- **Larghezza negativa.**

### Avvisi

- **Glifi vuoti con un carattere.**
- **Ancore diverse tra i master.**
- **Glifi che non finiranno nel font.** L'export di Fontra lascia fuori i glifi che non hanno un carattere, non sono usati da nessuna funzione OpenType e non sono usati come componente. Per esempio le alternative `.001`, `.002` quando non c'è una funzione `ss01` o `salt` che le usa.

- **Valori degli assi senza nome.** Un valore dell'asse senza nome (per esempio width 100) finisce nel font come un nome vuoto. In **Font Info → Axes** scrivi un nome (per il valore predefinito di solito **Normal**) e spunta **Elidable**: i nomi degli stili restano uguali.

**Copia resoconto** copia tutto come testo, da incollare dove vuoi.

## Riordinare i glifi dopo l'export

L'export di Fontra mette i glifi in ordine alfabetico per nome: A, AE, AEacute, Aacute…, poi a, aacute, ampersand…, con la eight in mezzo alle e. Il pannello **Glifi** di Illustrator (Mostra: Font intero) li mostra in quell'ordine. In Fontra non si può cambiare: l'export riordina sempre per nome e ignora anche un ordine personalizzato (`public.glyphOrder`).

Quindi si riordina il file già esportato:

1. **File → Riordina i glifi di un font esportato…** (c'è sia nella panoramica sia nell'editor).
2. **Scegli il font esportato…**: un `.otf` o un `.ttf`.
3. Il plugin mostra l'ordine di prima e quello nuovo, controlla che forme e larghezze siano identiche glifo per glifo (anche negli stili estremi) e poi abilita **Scarica il font riordinato**. Il file nuovo ha lo stesso nome e va nei Download.
4. Disinstalla il font vecchio e installa quello nuovo.

L'ordine è quello di Glyphs:
- le maiuscole, ognuna seguita dalle sue accentate (A Á Ă … Æ, B, C Ć Č Ç…);
- le minuscole, allo stesso modo;
- ª º, i numeri, lo spazio;
- la punteggiatura (. , : ; … ! ¡ ? ¿ · • * # / \ ( ) { } [ ] - – — _ e le virgolette);
- i simboli (valute, segni matematici, % ‰ @ & § © ® ™ ° |);
- gli accenti.

Il riordino lo fa **fontTools**, che gira nel browser con [Pyodide](https://pyodide.org). La prima volta il plugin scarica circa 13 MB, che poi restano nella cache del browser. Serve la connessione a internet. Forme, larghezze, kerning e funzioni OpenType non cambiano: cambia solo la posizione dei glifi nel file.

### E l'ordine degli stili?

Nel font esportato gli stili sono già in ordine: Light Narrow, Light, Light Wide, Regular Narrow, Regular, Regular Wide, Bold Narrow, Bold, Bold Wide. Illustrator però mette in cima lo stile di partenza del font variabile (Regular) e subito sotto quello selezionato. Gli altri restano nell'ordine giusto. È un comportamento delle app Adobe, e il font non può cambiarlo.

## Perché `.otf` e non `.ttf`

In TrueType (`.ttf`) le curve vengono convertite da cubiche a quadratiche. È un'approssimazione e aggiunge molti punti: nella O di DIESEL i punti passano da 32 a 60, e nella S da 44 a 80. In OpenType (`.otf`) le curve restano quelle che hai disegnato.

## Note tecniche

- L'unione dei tracciati la fa il server di Fontra (`/api/unionPath`, con skia-pathops). È lo stesso comando di «Remove overlaps» nel pannello Trasformazione.
- **Compatibilità tra i master.** Dopo l'unione, i contorni di ogni master vengono riordinati e il loro punto di partenza viene allineato al primo master. Può capitare che in un master una curva con le maniglie allineate diventi una linea: in quel caso la linea torna curva, con le maniglie a un terzo e due terzi, e la forma non cambia. Se i master non si possono far corrispondere, il glifo non viene toccato.
- **Diagnosi.** I punti originali hanno lo stesso numero in ogni master. Ogni punto del risultato è un punto originale oppure un incrocio tra due tratti originali, quindi confrontando i master si vede quale punto resta sul contorno in un master e finisce dentro la forma in un altro, e quali incroci ci sono in più o in meno.
- **Contorni.** Dopo l'unione, i contorni esterni girano in senso antiorario, come nel formato PostScript/CFF.
- **Modifiche e annullamento.** Le modifiche partono a blocchi di 40 glifi: il server tiene in memoria 128 glifi per volta. Anche l'annullamento con ⌘Z va a blocchi. Si applica solo nella panoramica, dove ⌘Z vale per tutto il font.
- **Glifi non esportati.** Per le funzioni OpenType il plugin cerca soltanto i nomi dei glifi nel testo delle funzioni.
- **Riordino.** Usa Pyodide 0.29.5 da cdn.jsdelivr.net (con 0.29.3 e 0.27.7 di riserva) e `fontTools.ttLib.reorderGlyphs`. Nei font CFF/CFF2 il plugin rimette in ordine anche il `charset` e le `CharStrings`, che `reorderGlyphs` lascia com'erano.

## Versioni

- **1.1.0**: nuovo comando **Riordina i glifi di un font esportato…**; nuovo avviso per i valori degli assi senza nome.
- **1.0.0**: prima versione.
