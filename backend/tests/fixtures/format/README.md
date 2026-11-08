# Wzorce formatu projektu

`v<N>/` – projekty zapisane przez wersję schematu N (`SCHEMA_VERSION`). Test
`tests/test_format.py` otwiera każdy, zapisuje i sprawdza, że żadna wartość nie zginęła ani się
nie zmieniła (nowe pola z wartościami domyślnymi mogą dojść), a projekt daje poprawną netlistę.

- **Nie edytuj** istniejących wzorców – to pliki „z przeszłości”.
- Przy podniesieniu `SCHEMA_VERSION` (z migracją w `bpt/document/migrations.py`): zostaw stare
  katalogi i dodaj `v<nowa>/` zapisany przez nową wersję. Stare wzorce sprawdzają migrację.
- `v1/kitchen_sink.bpt` używa wszystkich części formatu: arkusz-blok z parametrem, magistrala,
  etykieta globalna, dyrektywa, `.param`, model, model podobwodu, kopia symbolu, graf analizy.
