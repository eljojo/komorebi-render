{ lib, pkgs, self }:
let
  evaluate = service: lib.evalModules {
    specialArgs = { inherit pkgs; };
    modules = [
      (import ./darwin-module.nix self)
      ({ lib, ... }: {
        options = {
          system.primaryUser = lib.mkOption { type = lib.types.str; default = "jojo"; };
          system.activationScripts = lib.mkOption { type = lib.types.attrsOf lib.types.anything; default = {}; };
          launchd.user.agents = lib.mkOption { type = lib.types.attrsOf lib.types.anything; default = {}; };
        };
        config.services.komorebi-render = service;
      })
    ];
  };
  disabled = (evaluate {}).config;
  defaults = (evaluate { enable = true; outDir = "/Volumes/home/komorebi/jobs"; }).config;
  custom = (evaluate {
    enable = true;
    package = pkgs.hello;
    host = "127.0.0.1";
    port = 9000;
    stateDir = "/Users/render/state with space";
    outDir = "/Volumes/render/jobs";
    maxSeconds = 43200;
    arboretumTokenFile = "/Users/render/private/token";
  }).config;
  cfg = defaults.services.komorebi-render;
  agent = defaults.launchd.user.agents.komorebi-render;
  customAgent = custom.launchd.user.agents.komorebi-render;
in
assert disabled.launchd.user.agents == {};
assert disabled.system.activationScripts == {};
assert cfg.stateDir == "/Users/jojo/.local/state/komorebi-render";
assert cfg.host == "0.0.0.0" && cfg.port == 8077 && cfg.maxSeconds == 21600;
assert cfg.arboretumTokenFile == null;
assert agent.serviceConfig.ProgramArguments == [ "/usr/bin/caffeinate" "-i" "${self.packages.${pkgs.stdenv.hostPlatform.system}.default}/bin/komorebi-render" "serve" ];
assert agent.serviceConfig.KeepAlive && agent.serviceConfig.RunAtLoad;
assert agent.serviceConfig.StandardOutPath == "${cfg.stateDir}/stdout.log";
assert agent.serviceConfig.StandardErrorPath == "${cfg.stateDir}/stderr.log";
assert agent.serviceConfig.EnvironmentVariables == {
  KOMOREBI_RENDER_STATE = cfg.stateDir;
  KOMOREBI_RENDER_OUT = "/Volumes/home/komorebi/jobs";
  KOMOREBI_RENDER_HOST = "0.0.0.0";
  KOMOREBI_RENDER_PORT = "8077";
  KOMOREBI_RENDER_MAX_SECONDS = "21600";
};
assert lib.hasInfix "/usr/bin/install -d -m 700 -o jojo" defaults.system.activationScripts.preActivation.text;
assert customAgent.serviceConfig.ProgramArguments == [ "/usr/bin/caffeinate" "-i" "${pkgs.hello}/bin/komorebi-render" "serve" ];
assert customAgent.serviceConfig.EnvironmentVariables.KOMOREBI_RENDER_ARBORETUM_TOKEN_FILE == "/Users/render/private/token";
assert customAgent.serviceConfig.EnvironmentVariables.KOMOREBI_RENDER_PORT == "9000";
assert customAgent.serviceConfig.EnvironmentVariables.KOMOREBI_RENDER_MAX_SECONDS == "43200";
assert lib.hasInfix "/usr/bin/install -d -m 700 -o jojo" custom.system.activationScripts.preActivation.text;
assert lib.hasInfix "'/Users/render/state with space'" custom.system.activationScripts.preActivation.text;
pkgs.runCommand "komorebi-render-darwin-module" {} ''
  echo "darwin module: defaults, overrides, launchd arguments/environment/logs and activation directory checked"
  touch $out
''
