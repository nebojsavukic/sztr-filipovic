# Objavljivanje sajta na GitHub Pages — korak po korak

Ovo uputstvo ne traži nikakav program na računaru. Sve se radi kroz sajt
github.com, prevlačenjem fajlova mišem.

---

## PRE POČETKA: proverite ove tri stvari

GitHub servери rade na Linuxu, a Linux **razlikuje mala i velika slova**.
Windows ne razlikuje — zato nešto može raditi lokalno, a ne raditi na netu.

1. Folder se mora zvati **`assets`** — malim slovima. Ne `Assets`, ne `ASSETS`.
2. Fajl u njemu mora biti **`ograda.glb`** — malim slovima.
   Ako se zove `Ograda.GLB` ili `ograda.GLB`, model se **neće** učitati.
3. Nijedan fajl ne sme biti veći od **100 MB**. Ako je `ograda.glb` veći,
   javite mi i smanjićemo ga.

> **Važno:** nemojte koristiti Git LFS za `.glb` i `.mp4`. GitHub Pages ne
> podržava LFS — umesto modela bi servirao tekstualni fajl i sajt bi ostao
> prazan. Obično prevlačenje mišem je ispravno.

---

## KORAK 1 — Napravite nalog

Idite na **github.com** → **Sign up**. Besplatno je.

## KORAK 2 — Napravite repozitorijum

1. Gore desno kliknite **+** → **New repository**
2. **Repository name:** `sztr-filipovic` (mala slova, bez razmaka i kvačica)
3. Izaberite **Public** — GitHub Pages je besplatan samo za javne repozitorijume
4. **Ne** čekirajte "Add a README file"
5. **Create repository**

## KORAK 3 — Prebacite fajlove

Na stranici koja se otvori kliknite **uploading an existing file**.

Prevucite mišem u prozor:

- `index.html`
- `script.js`
- `style.css`
- `README-HIGGSFIELD.md`
- ceo folder **`assets`** (sa `ograda.glb` unutra)

Dole kliknite zeleno dugme **Commit changes**.

> Ako se folder `assets` ne prevuče, napravite ga ručno: **Add file** →
> **Create new file** → u polje za ime ukucajte `assets/prazno.txt` →
> **Commit**. Folder će nastati, pa onda u njega prevucite `ograda.glb`.

## KORAK 4 — Dodajte fajl `.nojekyll`

GitHub podrazumevano provlači sajt kroz sistem koji se zove Jekyll i koji
ume da preskoči neke fajlove. Ovaj prazan fajl to isključuje.

1. **Add file** → **Create new file**
2. U polje za ime ukucajte tačno: **`.nojekyll`** (sa tačkom na početku)
3. Sadržaj ostavite prazan
4. **Commit changes**

## KORAK 5 — Uključite GitHub Pages

1. U repozitorijumu kliknite **Settings** (gore desno)
2. U levoj koloni izaberite **Pages**
3. **Source:** `Deploy from a branch`
4. **Branch:** `main`, folder `/ (root)`
5. **Save**

## KORAK 6 — Sačekajte i otvorite sajt

Sačekajte 1–3 minuta, pa osvežite stranicu Settings → Pages.
Pojaviće se adresa vašeg sajta:

```
https://VASE-KORISNICKO-IME.github.io/sztr-filipovic/
```

To je to. Sajt je na internetu.

---

## AKO EKRAN BUDE PRAZAN

Sajt vam sada sam kaže šta nije u redu. Sačekajte 15 sekundi i pojaviće se
poruka sa spiskom provera (Three.js, GSAP, WebGL, 3D model).

Za pun ispis: pritisnite **F12** → kartica **Console**.

Najčešći uzroci, po redu verovatnoće:

| Šta vidite | Uzrok | Rešenje |
|---|---|---|
| Ograda se vidi, ali izgleda "kockasto" | `ograda.glb` nije nađen, radi rezervni model | Proverite mala/velika slova u `assets/ograda.glb` |
| Poruka "Sajt je otvoren kao datoteka" | Otvorili ste fajl duplim klikom | Otvorite pravu `github.io` adresu |
| Potpuno crn ekran, bez poruke | Reklamni blokator seče CDN | Isključite blokator na tom sajtu i osvežite |
| 404 stranica | Pages se još podiže | Sačekajte 3 minuta i osvežite |

## KAKO KASNIJE MENJATE SAJT

Otvorite fajl na GitHub-u → kliknite ikonicu olovke → izmenite →
**Commit changes**. Sajt se sam ažurira za oko minut.
