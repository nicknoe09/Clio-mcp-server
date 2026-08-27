import csv, json, sys, os
# usage: python3 add.py '<json list of row dicts>'
rows = json.loads(sys.argv[1])
cols = ['attorney','matter_number','clio_matter_id','classification','source_document','source_document_date','box_file_id','notes']
existing = {}
if os.path.exists('probate_classification_results.csv'):
    with open('probate_classification_results.csv') as f:
        for r in csv.DictReader(f):
            existing[r['matter_number']] = r
for r in rows:
    existing[r['matter_number']] = {c: r.get(c,'') for c in cols}
with open('probate_classification_results.csv','w',newline='') as f:
    w = csv.DictWriter(f, fieldnames=cols)
    w.writeheader()
    for k in sorted(existing):
        w.writerow(existing[k])
print('rows now:', len(existing))
