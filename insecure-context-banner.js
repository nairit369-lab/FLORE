/**
 * На телефоне по http://IP браузер не даёт микрофон, камеру, WebRTC и Web Crypto (нет secure context).
 * Показываем заметный блок с решением: HTTPS на сервере.
 */
(function () {
    try {
        if (typeof window === 'undefined' || window.isSecureContext) return;
    } catch (_) {
        return;
    }

    function inject() {
        if (document.getElementById('florInsecureCtxBanner')) return;
        var el = document.createElement('div');
        el.id = 'florInsecureCtxBanner';
        el.className = 'flor-insecure-ctx-banner';
        el.setAttribute('role', 'alert');
        el.innerHTML =
            '<strong>Соединение не защищено (HTTP).</strong> С телефона не будут работать звонки, микрофон и шифрование. ' +
            'На компьютере с сервером в файле <code>.env</code> задайте <code>USE_HTTPS=true</code> и ' +
            '<code>FLOR_TLS_SAN=localhost,127.0.0.1,ВАШ_LAN_IP</code> (IP ПК в Wi‑Fi), перезапустите сервер и откройте на телефоне ' +
            '<strong>https://ВАШ_LAN_IP:порт/login.html</strong> — один раз примите предупреждение о сертификате.';
        if (document.body) {
            document.body.insertBefore(el, document.body.firstChild);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', inject);
    } else {
        inject();
    }
})();
