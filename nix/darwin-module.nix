self: { config, lib, pkgs, ... }:
let
  cfg = config.services.komorebi-render;
  inherit (lib) mkEnableOption mkIf mkOption types;
in {
  options.services.komorebi-render = {
    enable = mkEnableOption "the komorebi render API and worker in the logged-in user's session";
    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      description = "The komorebi-render package.";
    };
    host = mkOption { type = types.str; default = "0.0.0.0"; description = "The HTTP listen address."; };
    port = mkOption { type = types.port; default = 8077; description = "The HTTP listen port."; };
    stateDir = mkOption {
      type = types.str;
      default = "/Users/${config.system.primaryUser}/.local/state/komorebi-render";
      description = "The local directory for the database, engine, browsers and service logs.";
    };
    outDir = mkOption { type = types.str; description = "The jobs directory on a mounted network share."; };
    maxSeconds = mkOption { type = types.ints.positive; default = 21600; description = "The maximum duration of a job, in seconds."; };
    arboretumTokenFile = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "An absolute path string to a token read by the program at startup. Use a string, not a Nix path literal, to keep the token out of the store.";
    };
  };

  config = mkIf cfg.enable {
    # launchd opens its logs before the program starts, so mkdir in serve would be too late.
    system.activationScripts.preActivation.text = ''
      /usr/bin/install -d -m 700 -o ${lib.escapeShellArg config.system.primaryUser} ${lib.escapeShellArg cfg.stateDir}
    '';
    launchd.user.agents.komorebi-render.serviceConfig = {
      ProgramArguments = [ "/usr/bin/caffeinate" "-i" "${cfg.package}/bin/komorebi-render" "serve" ];
      KeepAlive = true;
      RunAtLoad = true;
      StandardOutPath = "${cfg.stateDir}/stdout.log";
      StandardErrorPath = "${cfg.stateDir}/stderr.log";
      EnvironmentVariables = {
        KOMOREBI_RENDER_STATE = cfg.stateDir;
        KOMOREBI_RENDER_OUT = cfg.outDir;
        KOMOREBI_RENDER_HOST = cfg.host;
        KOMOREBI_RENDER_PORT = toString cfg.port;
        KOMOREBI_RENDER_MAX_SECONDS = toString cfg.maxSeconds;
      } // lib.optionalAttrs (cfg.arboretumTokenFile != null) {
        KOMOREBI_RENDER_ARBORETUM_TOKEN_FILE = cfg.arboretumTokenFile;
      };
    };
  };
}
