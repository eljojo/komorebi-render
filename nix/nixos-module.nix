self: { config, lib, pkgs, ... }:
let
  cfg = config.services.komorebi-render;
  inherit (lib) mkEnableOption mkIf mkOption types;
in {
  options.services.komorebi-render = {
    enable = mkEnableOption "the komorebi render API and worker";
    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      description = "The komorebi-render package.";
    };
    user = mkOption {
      type = types.str;
      default = "komorebi-render";
      description = "The service user. An existing user can be selected to match NFS ownership.";
    };
    host = mkOption { type = types.str; default = "0.0.0.0"; description = "The HTTP listen address."; };
    port = mkOption { type = types.port; default = 8077; description = "The HTTP listen port."; };
    stateDir = mkOption {
      type = types.str;
      default = "/var/lib/komorebi-render";
      description = "The local directory for the database and pinned engine.";
    };
    outDir = mkOption { type = types.str; description = "The jobs directory on a mounted network share."; };
    maxSeconds = mkOption { type = types.ints.positive; default = 21600; description = "The maximum duration of a job, in seconds."; };
  };

  config = mkIf cfg.enable {
    users.groups.komorebi-render = mkIf (cfg.user == "komorebi-render") {};
    users.users.komorebi-render = mkIf (cfg.user == "komorebi-render") {
      isSystemUser = true;
      group = "komorebi-render";
      home = cfg.stateDir;
    };
    systemd.tmpfiles.rules = [
      "d ${lib.escapeShellArg cfg.stateDir} 0700 ${cfg.user} ${config.users.users.${cfg.user}.group} - -"
    ];
    systemd.services.komorebi-render = {
      description = "Komorebi render API and worker";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];
      unitConfig.RequiresMountsFor = [ cfg.outDir ];
      environment = {
        KOMOREBI_RENDER_STATE = cfg.stateDir;
        KOMOREBI_RENDER_OUT = cfg.outDir;
        KOMOREBI_RENDER_HOST = cfg.host;
        KOMOREBI_RENDER_PORT = toString cfg.port;
        KOMOREBI_RENDER_MAX_SECONDS = toString cfg.maxSeconds;
      };
      serviceConfig = {
        ExecStart = "${cfg.package}/bin/komorebi-render serve";
        User = cfg.user;
        Group = config.users.users.${cfg.user}.group;
        SupplementaryGroups = [ "render" ];
        WorkingDirectory = cfg.stateDir;
        Restart = "on-failure";
        RestartSec = 5;
        UMask = "0077";
      };
    };
  };
}
