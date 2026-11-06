{ lib, pkgs, self }:
let
  evaluate = service: (import (pkgs.path + "/nixos/lib/eval-config.nix") {
    system = pkgs.stdenv.hostPlatform.system;
    modules = [
      (import ./nixos-module.nix self)
      {
        system.stateVersion = "26.05";
        users.users.jojo.isNormalUser = true;
        services.komorebi-render = service;
      }
    ];
  }).config;
  disabled = evaluate {};
  defaults = evaluate { enable = true; outDir = "/mnt/jojo_r2d2/komorebi/jobs"; };
  custom = evaluate {
    enable = true;
    user = "jojo";
    package = pkgs.hello;
    host = "127.0.0.1";
    port = 9000;
    stateDir = "/home/jojo/render state";
    outDir = "/mnt/jojo_r2d2/komorebi/jobs";
    maxSeconds = 43200;
  };
  unit = defaults.systemd.services.komorebi-render;
  customUnit = custom.systemd.services.komorebi-render;
in
assert !(disabled.systemd.services ? komorebi-render);
assert !(disabled.users.users ? komorebi-render);
assert unit.serviceConfig.ExecStart == "${self.packages.${pkgs.stdenv.hostPlatform.system}.default}/bin/komorebi-render serve";
assert unit.serviceConfig.User == "komorebi-render";
assert unit.serviceConfig.SupplementaryGroups == [ "render" ];
assert unit.serviceConfig.Restart == "on-failure";
assert unit.environment.KOMOREBI_RENDER_OUT == "/mnt/jojo_r2d2/komorebi/jobs";
assert !(unit.environment ? KOMOREBI_RENDER_ALLOW_LOCAL);
assert unit.unitConfig.RequiresMountsFor == [ "/mnt/jojo_r2d2/komorebi/jobs" ];
assert lib.elem "network-online.target" unit.after;
assert defaults.users.users.komorebi-render.isSystemUser;
assert customUnit.serviceConfig.ExecStart == "${pkgs.hello}/bin/komorebi-render serve";
assert customUnit.serviceConfig.User == "jojo";
assert customUnit.environment.KOMOREBI_RENDER_STATE == "/home/jojo/render state";
assert customUnit.environment.KOMOREBI_RENDER_HOST == "127.0.0.1";
assert customUnit.environment.KOMOREBI_RENDER_PORT == "9000";
assert customUnit.environment.KOMOREBI_RENDER_MAX_SECONDS == "43200";
assert lib.elem "d '/home/jojo/render state' 0700 jojo users - -" custom.systemd.tmpfiles.rules;
pkgs.runCommand "komorebi-render-nixos-module" {} ''
  echo "nixos module: disabled behavior, service user, GPU access, mount ordering and overrides checked"
  touch $out
''
