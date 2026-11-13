// The machines origin's pages. Posts go through fetch, which sends this
// origin in `Origin` (a plain form post under `Referrer-Policy: no-referrer`
// would send `Origin: null`, and the machines origin refuses that).
//
// Loaded blocking in <head> so the stored theme applies before first paint.
(function () {
  "use strict";

  try {
    var theme = localStorage.getItem("workbench.theme");
    if (theme === "light" || theme === "dark") document.documentElement.setAttribute("data-theme", theme);
  } catch {
    // Storage blocked (it is a separate origin from the box's): follow the system.
  }

  function post(path, body) {
    return fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    var signin = document.getElementById("machines-signin");
    if (signin) {
      var message = document.getElementById("machines-message");
      var nonce = signin.querySelector("input[name=nonce]");
      var passphrase = document.getElementById("passphrase");
      var submit = signin.querySelector("button[type=submit]");
      signin.addEventListener("submit", function (event) {
        event.preventDefault();
        submit.disabled = true;
        message.hidden = true;
        post("/signin", { nonce: nonce.value, passphrase: passphrase.value })
          .then(function (res) {
            return res.json().then(
              function (data) {
                return { ok: res.ok, data: data };
              },
              function () {
                return { ok: false, data: {} };
              },
            );
          })
          .then(function (r) {
            if (r.ok) {
              location.replace("/");
              return;
            }
            // Each answer spends the nonce; a refusal hands back a fresh one
            // while the box's session lasts, or says to start again.
            if (r.data.nonce) nonce.value = r.data.nonce;
            if (r.data.error === "restart") {
              location.replace(signin.getAttribute("data-restart"));
              return;
            }
            message.textContent = r.data.message || "That did not work. Try again.";
            message.hidden = false;
            passphrase.value = "";
            passphrase.focus();
          })
          .catch(function () {
            message.textContent = "The box did not answer. Try again.";
            message.hidden = false;
          })
          .finally(function () {
            submit.disabled = false;
          });
      });
    }

    // Admin: approve a join by the code typed from the machine's screen.
    var approve = document.getElementById("machines-approve");
    if (approve) {
      var approveMessage = document.getElementById("machines-message");
      approve.addEventListener("submit", function (event) {
        event.preventDefault();
        approveMessage.hidden = true;
        post("/_gate/machines/joins/approve", { code: approve.querySelector("input[name=code]").value })
          .then(function (res) {
            if (res.ok) return location.reload();
            return res.json().then(function (data) {
              approveMessage.textContent = data.message || "That did not work.";
              approveMessage.hidden = false;
            });
          })
          .catch(function () {
            approveMessage.textContent = "The box did not answer. Try again.";
            approveMessage.hidden = false;
          });
      });
    }

    // Admin: deny, revoke, remove.
    var buttons = document.querySelectorAll("[data-machines-post]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener("click", function (event) {
        var b = event.currentTarget;
        var ask = b.getAttribute("data-confirm");
        if (ask && !window.confirm(ask)) return;
        var body = b.getAttribute("data-body");
        b.disabled = true;
        post(b.getAttribute("data-machines-post"), body ? JSON.parse(body) : {}).finally(function () {
          location.reload();
        });
      });
    }

    var signout = document.getElementById("machines-signout");
    if (signout) {
      signout.addEventListener("submit", function (event) {
        event.preventDefault();
        post("/signout").finally(function () {
          location.replace("/signin");
        });
      });
    }
  });
})();
