# MenuBu Windows Customer Display Launcher

Bu proje, `order_customer_display.php` sayfasini Windows'ta ikinci ekranda cercevesiz ve tam ekran gorunume yakin kilitli pencere olarak acmak icin hazirlandi.

## Ozellikler

- Ikinci ekran varsa pencereyi otomatik olarak ikinci ekrana tasir ve boyutunu o ekranla esitler.
- Pencere `frame: false` oldugu icin cercevesiz acilir.
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

Farkli URL ile:

```bash
npm start -- --url="https://menubu.tr/panel/order_customer_display.php?popup=1&autofs=1"
```

veya

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
- Zorlayici kiosk kilidi icin `--hard-lock` parametresi desteklenir.
