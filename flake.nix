{
  description = "komorebi-render — a render server that runs komorebi's video exporter on a pinned commit";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "aarch64-darwin" "x86_64-darwin" "aarch64-linux" "x86_64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # Only what the server and its tests need: a stray file in the checkout must not change the package's hash.
      source = pkgs: pkgs.lib.fileset.toSource {
        root = ./.;
        fileset = pkgs.lib.fileset.unions [ ./src ./scripts ./test ./fixtures ./komorebi.json ./package.json ./llms.txt ./README.md ];
      };
    in {
      # `nix develop -c node --test` — node 22 (node:sqlite works without a flag from 22.13, with an ExperimentalWarning
      # on stderr), ffmpeg and git are the whole toolchain. The exporter's own deps (playwright, chromium) live in the
      # state dir, put there by `komorebi-render prepare`, never in nix.
      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = [ pkgs.nodejs_22 pkgs.ffmpeg pkgs.git ];
        };
      });

      # bin/komorebi-render. PATH is prefixed, not replaced: caffeinate lives in /usr/bin and must stay reachable.
      packages = forAll (pkgs: rec {
        komorebi-render = pkgs.stdenvNoCC.mkDerivation {
          pname = "komorebi-render";
          version = "0.1.0";
          src = source pkgs;
          nativeBuildInputs = [ pkgs.makeWrapper ];
          dontBuild = true;
          installPhase = ''
            runHook preInstall
            mkdir -p $out/lib/komorebi-render $out/bin
            cp -r src scripts komorebi.json package.json llms.txt $out/lib/komorebi-render/
            makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/komorebi-render \
              --add-flags "--disable-warning=ExperimentalWarning $out/lib/komorebi-render/src/cli.js" \
              --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.nodejs_22 pkgs.ffmpeg pkgs.git ]}
            runHook postInstall
          '';
          meta.mainProgram = "komorebi-render";
        };
        default = komorebi-render;
      });

      apps = forAll (pkgs: {
        default = { type = "app"; program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.default}/bin/komorebi-render"; };
      });

      # The tests are pure: a fake exporter stands in for render-video, there is no network and no GPU.
      checks = forAll (pkgs: {
        darwin-module = import ./nix/module-test.nix { inherit pkgs self; lib = pkgs.lib; };
        package = pkgs.runCommand "komorebi-render-package" {} ''
          cmp ${./llms.txt} ${self.packages.${pkgs.stdenv.hostPlatform.system}.default}/lib/komorebi-render/llms.txt
          ${self.packages.${pkgs.stdenv.hostPlatform.system}.default}/bin/komorebi-render
          echo "package: llms.txt installed and CLI wrapper runs"
          touch $out
        '';
        tests = pkgs.runCommand "komorebi-render-tests" { nativeBuildInputs = [ pkgs.nodejs_22 pkgs.git pkgs.ffmpeg ]; } ''
          cp -r ${source pkgs} work
          chmod -R u+w work
          cd work
          export HOME=$TMPDIR
          node --disable-warning=ExperimentalWarning --test
          touch $out
        '';
      });

      # The logged-in session owns the GPU and keychain; the module runs the API and worker together as a user agent.
      darwinModules.default = import ./nix/darwin-module.nix self;
    };
}
