# MenuBu Desktop (Windows)

Bu proje `MenuBu Desktop` uygulamasidir ve iki pencereli calisir:

- Ana panel: 1. ekranda `https://www.menubu.tr/panel`
- Musteri ekrani: buton/protocol tetiklemesi ile 2. ekranda `order_customer_display.php`

## Ozellikler

- Launcher acildiginda ana panel 1. ekranda acilir.
- `menubu-display://` tetiklenince musteri ekrani 2. ekranda acilir.
- Musteri ekrani `frame: false` oldugu icin cercevesizdir.
- Ikinci ekran varsa musteri penceresi otomatik o ekrana tasinir ve boyutu kilitlenir.
- Uygulama protokolu destekler: `menubu-display://`
- Webdeki topbar butonundan local launcher tetiklenebilir.
- `Ctrl+Shift+Q` ile acil kapanis kisayolu vardir.

## Klasor

`tools/kiosk/windows-customer-display-app`

## Gelistirme

```bash
cd tools/kiosk/windows-customer-display-app
npm install
npm start
```

Kiosk mod:

```bash
npm run start:kiosk
```

Farkli panel URL ile:

```bash
npm start -- --panel-url="https://www.menubu.tr/panel"
```

Farkli musteri ekrani URL ile:

```bash
MENUBU_CUSTOMER_URL="https://menubu.tr/panel/order_customer_display.php?popup=1&autofs=1" npm start
```

## Windows EXE Build (lokal)

```bash
cd tools/kiosk/windows-customer-display-app
npm install
npm run dist:win
```

Cikti dizini:

`tools/kiosk/windows-customer-display-app/dist/`

## Protocol Tetikleme (Topbar Butonu)

Launcher kurulduktan sonra web tarafindan su sekilde tetiklenir:

```js
function openCustomerDisplayLauncher() {
  const targetUrl = 'https://menubu.tr/panel/order_customer_display.php?popup=1&autofs=1';
  const protocolUrl = `menubu-display://open?url=${encodeURIComponent(targetUrl)}`;
  window.location.href = protocolUrl;
}
```

Buton:

```html
<button type="button" onclick="openCustomerDisplayLauncher()">Musteri Ekrani</button>
```

## Notlar

- Protokol kaydi uygulama ilk calistiginda `setAsDefaultProtocolClient` ile yapilir.
- Kurulu degilse `menubu-display://` acilmaz; bu durumda web tarafinda fallback akisi ekleyebilirsiniz.
- `--kiosk` ve `--hard-lock` modlari musteri ekrani penceresinde kullanilir.
- Pavo/local cihaz erisimi icin local network uyumluluk modu varsayilan olarak aciktir.
  - Kapatmak icin: `MENUBU_ALLOW_LOCAL_NETWORK=0 npm start`
  - Strict calistirmak icin: `npm start -- --strict-local-network`
