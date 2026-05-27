{
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
  };
  outputs = {nixpkgs, ...}: let
    forAllSystems = function:
      nixpkgs.lib.genAttrs nixpkgs.lib.systems.flakeExposed (
        system: function nixpkgs.legacyPackages.${system}
      );
  in {
    formatter = forAllSystems (pkgs: pkgs.alejandra);
    devShells = forAllSystems (pkgs: {
      default = pkgs.mkShell {
        packages = with pkgs;
          [
            corepack
            nodejs_24
          ]
          ++ lib.optionals stdenv.isLinux [chromium];
        shellHook = pkgs.lib.optionalString pkgs.stdenv.isLinux ''
          export EFX_CHROMIUM="${pkgs.chromium}/bin/chromium"
        '';
      };
    });
  };
}
