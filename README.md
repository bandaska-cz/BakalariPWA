# 🦉 Školní parťák – Bakaláři PWA pro základní školu

Kompletní **Progressive Web App (PWA)** pro žákyni základní školy postavená na specifikaci **[Bakaláři API v3](https://github.com/bakalari-api/bakalari-api-v3)**.

## ✨ Hlavní funkce

1. **Vyskakovací upozornění s povinným ručním potvrzením**:
   - **☀️ Každé ráno (výchozí 07:00)**: Zobrazí aktuální rozvrh na dnešní den, odpolední kroužky a kontrolní seznam věcí (učebnice, cvičební úbor, svačina, čip). Okno nelze zavřít klávesou `Esc` ani kliknutím mimo – dcera musí odškrtnout kontrolní seznam a kliknout na **„✋ Potvrzuji, že mám vše připravené a vyrážím!“**.
   - **🕔 Každý pracovní den v 17:00**: Zkontroluje domácí úkoly na následující školní den a zobrazí vyskakovací upozornění s přehledem úkolů a povinným potvrzením.
   - **🌙 Každý večer (výchozí 19:30)**: Zobrazí rozvrh a kroužky na následující školní den pro večerní sbalení aktovky s povinným potvrzením.
   - Obsahuje **systémové Web Notifications (`requireInteraction: true`)**, zvukovou znělku (Web Audio API) s opakováním do potvrzení a okamžité testovací přepínače v hlavičce.
2. **Aktuální rozvrh hodin + ruční přidání kroužků**:
   - Načítá živý rozvrh z `/api/3/timetable/actual` včetně suplování, odpadlých hodin a změn místností.
   - Přepínání mezi **denním přehledem** a **celotýdenní tabulkou** (tento týden / příští týden).
   - **Možnost ručně přidat, upravit a mazat odpolední kroužky** (název, den v týdnu, čas od–do, místo, pomůcky s sebou, barva). Pomůcky na kroužek se automaticky propisují do ranního i večerního kontrolního seznamu.
3. **Známky a odhad průměru na vysvědčení**:
   - Načítá známky a jejich váhy z `/api/3/marks` (včetně znamének `1-`, `2-` atd.).
   - Počítá přesný vážený průměr z každého předmětu, **odhadovanou známku na vysvědčení (1–5)**, **celkový průměr na vysvědčení** a vyhodnocuje nárok na **Vyznamenání 🏆**.
   - **Kalkulačka „Co když dostanu...“ (What-If simulátor)**: Umožňuje jedním kliknutím vyzkoušet známku nanečisto a ukazuje chytré tipy (např. kolik jedniček a s jakou váhou stačí k vylepšení dvojky na jedničku).
4. **Domácí úkoly**:
   - Načítá úkoly z `/api/3/homeworks` + umožňuje přidávat **vlastní domácí úkoly** (zadané ústně při hodině) a odškrtávat je jako splněné.

---

## 🚀 Jak aplikaci spustit

### Možnost A: Spuštění přes přiložený Node.js server (Doporučeno)
Přiložený skript `proxy-server.js` nevyžaduje žádné `npm install` (používá jen vestavěné moduly Node.js) a zároveň slouží jako lokální CORS proxy pro napojení na libovolný školní server Bakaláři:

```powershell
cd c:\Users\radek.bunda\DEV\Personal\BakalariPWA
node proxy-server.js
```

Poté otevřete v prohlížeči: **http://localhost:3000**

*(Pokud se připojujete ke školnímu serveru Bakaláři, který blokuje přímé CORS požadavky z prohlížeče, zadejte v záložce **Bakaláři & Časy** do pole CORS Proxy adresu `http://localhost:3000`).*

### Možnost B: Ukázkový režim (Demo ZŠ)
Aplikace po prvním otevření automaticky běží v **Ukázkovém režimu (Demo ZŠ – 6.A)** s připraveným rozvrhem, kroužky, známkami i domácími úkoly na zítřek, takže si můžete okamžitě vyzkoušet všechna 3 vyskakovací upozornění (tlačítka **☀️ Ráno**, **🕔 17:00 Úkoly**, **🌙 Večer** v horní liště).

